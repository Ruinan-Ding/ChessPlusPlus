"""Probe the private backend using the public host and trusted proxy scheme."""
import os
from urllib.request import Request, urlopen


request = Request('http://127.0.0.1:8000/health/ready/', headers={
    'Host': os.environ['DJANGO_ALLOWED_HOSTS'].split(',')[0].strip(),
    'X-Forwarded-Proto': 'https',
})
with urlopen(request, timeout=4) as response:
    if response.status != 200:
        raise SystemExit(1)
