"""Build and exercise disposable production containers; never deploy to a cloud."""
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


def spare_port():
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


def main():
    docker = shutil.which('docker')
    if not docker:
        raise SystemExit('Docker with Compose is required.')
    subprocess.run([docker, 'info'], check=True, stdout=subprocess.DEVNULL)
    tag = 'cpp-check-' + secrets.token_hex(5)
    http_port, https_port = spare_port(), spare_port()
    while https_port == http_port:
        https_port = spare_port()
    environment = os.environ.copy()
    environment.update({
        'CPP_DOMAIN': 'localhost', 'CPP_IMAGE_TAG': tag,
        'CPP_BIND_ADDRESS': '127.0.0.1', 'CPP_HTTP_PORT': str(http_port),
        'CPP_HTTPS_PORT': str(https_port), 'DJANGO_SECRET_KEY': secrets.token_urlsafe(64),
        'DJANGO_DB_PATH': '/data/game.sqlite3', 'DJANGO_SECURE_HSTS_SECONDS': '3600',
        'CPP_BACKEND_MEMORY': '512m', 'CPP_BACKEND_CPUS': '1.0',
    })
    with tempfile.TemporaryDirectory(prefix=tag) as directory:
        temporary = Path(directory)
        env_file = temporary / '.env'
        env_file.touch()
        compose = [docker, 'compose', '--project-name', tag, '--env-file', str(env_file), '-f', str(ROOT / 'compose.yaml')]

        def run(*arguments, capture=False, check=True):
            return subprocess.run(
                compose + list(arguments), cwd=ROOT, env=environment, check=check,
                text=True, stdout=subprocess.PIPE if capture else None,
            )

        def database_count():
            code = 'import django; django.setup(); from game.models import GameState; print(GameState.objects.count())'
            return int(run('exec', '-T', 'backend', 'python', '-c', code, capture=True).stdout.strip())

        try:
            run('config', '--quiet')
            run('build', '--pull')
            run('run', '--rm', 'backend', 'python', '-m', 'django', 'check', '--deploy')
            run('run', '--rm', 'backend', 'python', '-m', 'django', 'migrate', '--noinput')
            run('up', '-d', '--wait', '--wait-timeout', '90')
            run('exec', '-T', 'backend', 'python', '-c',
                'import os; from pathlib import Path; '
                'assert os.geteuid() == 10001; '
                'assert not Path("db.sqlite3").exists(); assert not Path("venv").exists()')

            certificate = temporary / 'caddy-root.crt'
            for attempt in range(30):
                result = run('cp', 'web:/data/caddy/pki/authorities/local/root.crt', str(certificate), check=False, capture=True)
                if result.returncode == 0:
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError('Caddy local certificate was not created.')
            context = ssl.create_default_context(cafile=str(certificate))
            base = f'https://localhost:{https_port}'

            def get(path):
                with urlopen(base + path, context=context, timeout=8) as response:
                    return response.status, response.headers, response.read()

            def wait_ready():
                for attempt in range(45):
                    try:
                        if get('/health/ready/')[0] == 200:
                            return
                    except (URLError, OSError):
                        pass
                    time.sleep(0.5)
                raise RuntimeError('HTTPS readiness did not recover.')

            wait_ready()
            for path in ['/health/live/', '/health/ready/']:
                status, _, body = get(path)
                assert status == 200 and json.loads(body) == {'status': 'ok'}, path
            status, headers, html = get('/login')
            assert status == 200 and b'<app-root' in html
            assert headers.get('Strict-Transport-Security') and headers.get('X-Content-Type-Options') == 'nosniff'
            assert get('/game-room/deployment-probe')[2] == html
            asset = re.search(rb'src="([^"]+\.js)"', html).group(1).decode()
            assert b'<app-root' not in get('/' + asset.lstrip('/'))[2]
            try:
                get('/admin/')
            except HTTPError as error:
                assert error.code == 404
            else:
                raise AssertionError('Public admin was exposed.')
            with closing(http.client.HTTPConnection('localhost', http_port, timeout=8)) as connection:
                connection.request('GET', '/login')
                response = connection.getresponse()
                assert response.status == 308 and response.getheader('Location') == base + '/login'

            network = environment | {
                'E2E_HOST': 'localhost', 'E2E_PORT': str(https_port),
                'E2E_ORIGIN': base, 'E2E_TLS_CA': str(certificate),
            }
            subprocess.run([sys.executable, str(ROOT / 'server/scripts/e2e/match.py')], cwd=ROOT, env=network, check=True)
            cpu_probe = '''
import json
from wslib import WS
with open('shared/default-config.json', encoding='utf-8') as source:
    config = json.load(source)
client = WS('/ws/cpu/')
try:
    client.send({'type':'think','id':1,'config':config,'actions':[],'ply':1,'color':'white','difficulty':'easy','budget':0.05})
    result = client.type('cpu_turn', seconds=20)
    assert isinstance(result['commands'], list)
finally:
    client.close()
try:
    rejected = WS('/ws/game/lobby/', origin='https://untrusted.invalid')
except (AssertionError, ConnectionError):
    pass
else:
    rejected.close()
    raise AssertionError('Hostile WebSocket origin accepted')
'''
            subprocess.run(
                [sys.executable, '-c', cpu_probe], cwd=ROOT,
                env=network | {'PYTHONPATH': str(ROOT / 'server/scripts/e2e')}, check=True,
            )
            count = database_count()
            assert count > 0
            run('restart', 'backend')
            wait_ready()
            assert database_count() == count
            run('exec', '-T', 'backend', 'python', 'scripts/db_backup.py', 'backup', '/data/game.sqlite3', '/backups/smoke.sqlite3')
            run('stop', 'backend')
            run('run', '--rm', 'backend', 'python', 'scripts/db_backup.py', 'restore', '/backups/smoke.sqlite3', '/data/restored.sqlite3', '--offline')
            environment['DJANGO_DB_PATH'] = '/data/restored.sqlite3'
            run('up', '-d', '--wait', '--wait-timeout', '90')
            wait_ready()
            assert database_count() == count
            print('PASS: HTTPS/assets/deep links, real PvP and CPU WSS, origin rejection, restart persistence and offline restore.')
        finally:
            run('logs', '--no-color', '--tail', '60', check=False)
            run('down', '--volumes', '--remove-orphans')
            subprocess.run([docker, 'image', 'rm', f'chessplusplus-backend:{tag}', f'chessplusplus-web:{tag}'], check=False)


if __name__ == '__main__':
    main()
