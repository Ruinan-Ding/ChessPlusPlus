"""Deployment configuration, health and SQLite recovery without production data."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.db import OperationalError
from django.test import SimpleTestCase, TestCase


SERVER = Path(__file__).resolve().parents[2]
TEST_SECRET = 'deployment-fixture-only-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFG'


class DeploymentConfigurationTests(SimpleTestCase):
    def probe(self, module='core.production', **overrides):
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(('DJANGO_', 'REDIS_', 'CPP_'))
        }
        environment.update({
            'DJANGO_DEBUG': 'false',
            'DJANGO_SECRET_KEY': TEST_SECRET,
            'DJANGO_ALLOWED_HOSTS': 'game.example.com',
            'DJANGO_DB_PATH': str(Path(self.directory) / 'game.sqlite3'),
        })
        for key, value in overrides.items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        code = (
            'import importlib,json; s=importlib.import_module(' + repr(module) + '); '
            'print(json.dumps({"debug":s.DEBUG,"db":str(s.DATABASES["default"]["NAME"]),'
            '"hosts":s.ALLOWED_HOSTS,"redirect":getattr(s,"SECURE_SSL_REDIRECT",False),'
            '"session":getattr(s,"SESSION_COOKIE_SECURE",False),'
            '"csrf":getattr(s,"CSRF_COOKIE_SECURE",False),'
            '"hsts":getattr(s,"SECURE_HSTS_SECONDS",0),'
            '"proxy":getattr(s,"SECURE_PROXY_SSL_HEADER",None)}))'
        )
        return subprocess.run(
            [sys.executable, '-c', code], cwd=SERVER, env=environment,
            text=True, capture_output=True, timeout=15,
        )

    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = self.temporary.name

    def test_database_path_override_preserves_local_defaults(self):
        configured = self.probe('core.settings', DJANGO_DEBUG='true')
        self.assertEqual(configured.returncode, 0, configured.stderr)
        self.assertEqual(json.loads(configured.stdout)['db'], str(Path(self.directory) / 'game.sqlite3'))
        default = self.probe('core.settings', DJANGO_DEBUG='true', DJANGO_DB_PATH=None)
        self.assertEqual(default.returncode, 0, default.stderr)
        values = json.loads(default.stdout)
        self.assertEqual(Path(values['db']), SERVER / 'db.sqlite3')
        self.assertTrue(values['debug'])
        self.assertFalse(values['redirect'])
        self.assertIsNone(values['proxy'])

    def test_production_enables_transport_security(self):
        result = self.probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        self.assertFalse(values['debug'])
        self.assertEqual(values['hosts'], ['game.example.com'])
        self.assertTrue(values['redirect'])
        self.assertTrue(values['session'])
        self.assertTrue(values['csrf'])
        self.assertGreater(values['hsts'], 0)
        self.assertEqual(values['proxy'], ['HTTP_X_FORWARDED_PROTO', 'https'])

    def test_production_refuses_unsafe_or_missing_inputs(self):
        for invalid in [
            {'DJANGO_DEBUG': 'true'},
            {'DJANGO_SECRET_KEY': None},
            {'DJANGO_SECRET_KEY': 'change-me'},
            {'DJANGO_SECRET_KEY': 'django-insecure-' + TEST_SECRET},
            {'DJANGO_ALLOWED_HOSTS': None},
            {'DJANGO_ALLOWED_HOSTS': '*'},
            {'DJANGO_ALLOWED_HOSTS': '.example.com'},
            {'DJANGO_DB_PATH': None},
            {'DJANGO_DB_PATH': 'relative.sqlite3'},
            {'DJANGO_DB_PATH': ':memory:'},
        ]:
            with self.subTest(invalid=tuple(invalid)):
                self.assertNotEqual(self.probe(**invalid).returncode, 0)


class DeploymentHealthTests(TestCase):
    def test_liveness_does_not_need_database_access(self):
        with patch('django.db.migrations.executor.MigrationExecutor', side_effect=AssertionError('database touched')):
            response = self.client.get('/health/live/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})

    def test_readiness_accepts_migrated_database(self):
        response = self.client.get('/health/ready/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ok'})

    def test_readiness_reports_unavailable_database_without_details(self):
        with patch('core.health.MigrationExecutor', side_effect=OperationalError('private database path')):
            response = self.client.get('/health/ready/')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'status': 'unavailable'})
        self.assertNotIn(b'private', response.content)

    def test_readiness_refuses_pending_migrations(self):
        with patch('core.health.MigrationExecutor') as executor:
            executor.return_value.migration_plan.return_value = [(object(), False)]
            response = self.client.get('/health/ready/')
        self.assertEqual(response.status_code, 503)

    def test_probes_accept_head_and_refuse_writes(self):
        for path in ['/health/live/', '/health/ready/']:
            with self.subTest(path=path):
                self.assertEqual(self.client.head(path).status_code, 200)
                self.assertEqual(self.client.post(path).status_code, 405)


class DatabaseRecoveryTests(SimpleTestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / 'source #1.sqlite3'
        self.backup = self.directory / 'backup.sqlite3'
        self.restored = self.directory / 'restored.sqlite3'
        with closing(sqlite3.connect(self.source)) as connection:
            connection.execute('CREATE TABLE moves (value TEXT)')
            connection.execute('INSERT INTO moves VALUES (?)', ('saved turn',))
            connection.commit()

    def test_backup_includes_committed_wal_without_uncommitted_moves(self):
        from scripts.db_backup import backup_database

        with closing(sqlite3.connect(self.source)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('INSERT INTO moves VALUES (?)', ('committed WAL',))
            writer.commit()
            writer.execute('INSERT INTO moves VALUES (?)', ('uncommitted',))
            backup_database(self.source, self.backup)
            writer.rollback()
        with closing(sqlite3.connect(self.backup)) as snapshot:
            self.assertEqual(snapshot.execute('SELECT value FROM moves').fetchall(), [('saved turn',), ('committed WAL',)])
            self.assertEqual(snapshot.execute('PRAGMA integrity_check').fetchone(), ('ok',))

    def test_existing_destination_is_never_overwritten(self):
        from scripts.db_backup import backup_database

        self.backup.write_bytes(b'keep this file')
        with self.assertRaises(FileExistsError):
            backup_database(self.source, self.backup)
        self.assertEqual(self.backup.read_bytes(), b'keep this file')

    def test_bad_source_leaves_no_destination_or_partial_backup(self):
        from scripts.db_backup import backup_database

        self.source.write_bytes(b'corrupted')
        with self.assertRaises(sqlite3.DatabaseError):
            backup_database(self.source, self.backup)
        self.assertFalse(self.backup.exists())
        self.assertEqual(set(self.directory.iterdir()), {self.source})

    def test_restore_requires_offline_acknowledgement_and_new_path(self):
        from scripts.db_backup import backup_database, restore_database

        backup_database(self.source, self.backup)
        with self.assertRaises(ValueError):
            restore_database(self.backup, self.restored)
        restore_database(self.backup, self.restored, offline=True)
        with closing(sqlite3.connect(self.restored)) as restored:
            self.assertEqual(restored.execute('SELECT value FROM moves').fetchall(), [('saved turn',)])
        with self.assertRaises(FileExistsError):
            restore_database(self.backup, self.source, offline=True)

    def test_missing_source_and_stale_restore_sidecars_are_refused(self):
        from scripts.db_backup import backup_database, restore_database

        missing = self.directory / 'missing.sqlite3'
        with self.assertRaises(sqlite3.OperationalError):
            backup_database(missing, self.backup)
        self.assertFalse(missing.exists())
        self.assertFalse(self.backup.exists())
        sidecar = Path(str(self.restored) + '-wal')
        sidecar.write_bytes(b'preserve stale WAL')
        with self.assertRaises(FileExistsError):
            restore_database(self.source, self.restored, offline=True)
        self.assertFalse(self.restored.exists())
        self.assertEqual(sidecar.read_bytes(), b'preserve stale WAL')

    def test_backup_and_restore_refuse_orphaned_destination_sidecars(self):
        from scripts.db_backup import backup_database, restore_database

        for action in ('backup', 'restore'):
            for suffix in ('-wal', '-shm', '-journal'):
                with self.subTest(action=action, suffix=suffix):
                    destination = self.directory / f'{action}{suffix}.sqlite3'
                    sidecar = Path(str(destination) + suffix)
                    sidecar.write_bytes(b'preserve orphaned sidecar')
                    operation = backup_database if action == 'backup' else restore_database
                    options = {} if action == 'backup' else {'offline': True}
                    before = set(self.directory.iterdir())
                    with self.assertRaises(FileExistsError):
                        operation(self.source, destination, **options)
                    self.assertEqual(set(self.directory.iterdir()), before)
                    self.assertEqual(sidecar.read_bytes(), b'preserve orphaned sidecar')

    def test_backup_and_restore_check_resolved_symlink_destinations(self):
        from scripts.db_backup import backup_database, restore_database

        for action in ('backup', 'restore'):
            destination = self.directory / f'{action}-target.sqlite3'
            alias = self.directory / f'{action}-alias.sqlite3'
            try:
                alias.symlink_to(destination)
            except OSError as error:
                if getattr(error, 'winerror', None) != 1314:
                    raise
                self.skipTest(f'Creating symlinks requires Windows privileges: {error}')
            with self.subTest(action=action):
                sidecar = Path(str(destination) + '-wal')
                sidecar.write_bytes(b'preserve resolved target WAL')
                operation = backup_database if action == 'backup' else restore_database
                options = {} if action == 'backup' else {'offline': True}
                before = set(self.directory.iterdir())
                with self.assertRaises(FileExistsError):
                    operation(self.source, alias, **options)
                self.assertEqual(set(self.directory.iterdir()), before)
                self.assertTrue(alias.is_symlink())
                self.assertFalse(destination.exists())
                self.assertEqual(sidecar.read_bytes(), b'preserve resolved target WAL')

    def test_backup_refuses_replayable_wal_created_during_copy(self):
        from scripts.db_backup import backup_database

        with closing(sqlite3.connect(self.source)) as database:
            database.execute('PRAGMA journal_mode=WAL')
        donor = self.directory / 'stale.sqlite3'
        with closing(sqlite3.connect(donor)) as database:
            database.execute('PRAGMA journal_mode=WAL')
            database.execute('CREATE TABLE moves (value TEXT)')
            database.execute('INSERT INTO moves VALUES (?)', ('stale turn',))
            database.commit()
            stale_wal = Path(str(donor) + '-wal').read_bytes()
        sidecar = Path(str(self.backup) + '-wal')
        fsync = os.fsync

        def create_sidecar(descriptor):
            fsync(descriptor)
            sidecar.write_bytes(stale_wal)

        with patch('scripts.db_backup.os.fsync', side_effect=create_sidecar):
            with self.assertRaises(FileExistsError):
                backup_database(self.source, self.backup)
        self.assertFalse(self.backup.exists())
        self.assertEqual(sidecar.read_bytes(), stale_wal)
        self.assertFalse(list(self.directory.glob('.backup.sqlite3.*')))

    def test_cli_round_trip_and_refusal_exit_codes(self):
        command = [sys.executable, str(SERVER / 'scripts' / 'db_backup.py')]
        for arguments in [
            ['backup', str(self.source), str(self.backup)],
            ['restore', str(self.backup), str(self.restored), '--offline'],
        ]:
            result = subprocess.run(command + arguments, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(command + ['restore', str(self.backup), str(self.restored), '--offline'], text=True, capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        for action in ('backup', 'restore'):
            destination = self.directory / f'{action}-blocked.sqlite3'
            Path(str(destination) + '-wal').write_bytes(b'orphaned WAL')
            arguments = [action, str(self.source), str(destination)]
            if action == 'restore':
                arguments.append('--offline')
            result = subprocess.run(command + arguments, text=True, capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('verified', result.stdout.lower())
            self.assertFalse(destination.exists())
