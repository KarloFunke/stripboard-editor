#!/bin/sh
set -e

echo "Running migrations..."
python manage.py migrate --noinput

echo "Migrating project data..."
# Brings stored projects up to the current schema before any request is served,
# so a deploy never leaves the frontend reading rows older than it understands.
# Idempotent and never fatal: on failure rows are still migrated as they are
# read, so a bad batch run must not keep the site down.
python manage.py migrate_project_data || echo "WARNING: project data migration failed, falling back to migrating on read"

echo "Creating cache table..."
python manage.py createcachetable 2>/dev/null || true

echo "Collecting static files..."
python manage.py collectstatic --noinput

echo "Starting gunicorn..."
exec gunicorn config.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers 2 \
    --timeout 120
