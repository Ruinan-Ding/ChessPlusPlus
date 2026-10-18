"""Single-host production settings behind the private Caddy proxy."""
import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

from .settings import *


if DEBUG:
    raise ImproperlyConfigured('Production requires DJANGO_DEBUG=false.')
if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5 or SECRET_KEY.startswith('django-insecure-'):
    raise ImproperlyConfigured('Production requires a strong, unique DJANGO_SECRET_KEY.')
if any('*' in host or host.startswith('.') or '/' in host for host in ALLOWED_HOSTS):
    raise ImproperlyConfigured('Production requires exact DJANGO_ALLOWED_HOSTS values.')
if not os.environ.get('DJANGO_DB_PATH') or not Path(DATABASES['default']['NAME']).is_absolute():
    raise ImproperlyConfigured('Production requires an absolute persistent DJANGO_DB_PATH.')

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = int(os.environ.get('DJANGO_SECURE_HSTS_SECONDS', '3600'))
if SECURE_HSTS_SECONDS <= 0:
    raise ImproperlyConfigured('DJANGO_SECURE_HSTS_SECONDS must be positive.')
