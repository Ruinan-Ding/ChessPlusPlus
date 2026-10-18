# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS frontend
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
COPY shared/ /app/shared/
RUN npm run build

FROM python:3.14-slim-bookworm@sha256:48b13b003dda20b16f9442b8475aa05fe21bf6579a8c881db92ffb4d8fd20f83 AS backend
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=core.production \
    DJANGO_DEBUG=false
WORKDIR /app/server
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./
COPY shared/ /app/shared/
RUN DJANGO_DEBUG=true DJANGO_SETTINGS_MODULE=core.settings python -m django collectstatic --noinput \
    && useradd --uid 10001 --user-group --no-create-home app \
    && mkdir /data /backups \
    && chown app:app /data /backups
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["python", "scripts/healthcheck.py"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "core.asgi:application"]

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web
COPY --from=frontend /app/client/dist/client/browser/ /srv/
COPY --from=backend /app/server/staticfiles/ /srv/static/
COPY deploy/Caddyfile /etc/caddy/Caddyfile
