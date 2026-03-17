#!/bin/sh
set -e

echo "Running migrations..."
python manage.py migrate --noinput

echo "Creating cache table..."
python manage.py createcachetable 2>/dev/null || true

echo "Collecting static files..."
python manage.py collectstatic --noinput

echo "Starting gunicorn..."
exec gunicorn config.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers 3 \
    --timeout 120
