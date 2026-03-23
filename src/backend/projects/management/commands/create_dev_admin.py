"""
Create a superuser for local development.

Usage: python manage.py create_dev_admin --username admin --password admin

The password is SHA-256 hashed before storing, matching the frontend's login flow.
The DualPasswordBackend handles both raw passwords (admin panel) and
pre-hashed passwords (frontend), so you can use the same plain password everywhere.
"""

import hashlib
from django.core.management.base import BaseCommand
from django.contrib.auth.models import User


class Command(BaseCommand):
    help = "Create a dev superuser compatible with both admin and frontend login"

    def add_arguments(self, parser):
        parser.add_argument("--username", default="admin")
        parser.add_argument("--password", default="admin")

    def handle(self, *args, **options):
        username = options["username"]
        raw_password = options["password"]

        # Hash the password the same way the frontend does
        prehashed = hashlib.sha256(raw_password.encode()).hexdigest()

        if User.objects.filter(username=username).exists():
            user = User.objects.get(username=username)
            user.set_password(prehashed)
            user.is_superuser = True
            user.is_staff = True
            user.save()
            self.stdout.write(self.style.SUCCESS(f"Updated existing user '{username}'"))
        else:
            User.objects.create_superuser(username=username, password=prehashed)
            self.stdout.write(self.style.SUCCESS(f"Created superuser '{username}'"))

        self.stdout.write(f"Login with username='{username}', password='{raw_password}' (works on both admin and frontend)")
