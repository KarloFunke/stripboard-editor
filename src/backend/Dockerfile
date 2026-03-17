FROM python:3.13-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy application
COPY . .

# Collect static files (admin etc.)
RUN python manage.py collectstatic --noinput 2>/dev/null || true

EXPOSE 8000

CMD ["./entrypoint.sh"]
