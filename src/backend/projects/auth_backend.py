import hashlib
from django.contrib.auth.backends import ModelBackend


class SHA256PreHashBackend(ModelBackend):
    """
    Auth backend that accepts both raw passwords (admin panel)
    and pre-hashed SHA-256 passwords (frontend API).

    When a raw password is received (not 64 hex chars), it gets
    SHA-256 hashed first before checking against Django's stored hash.
    This way the admin panel works with normal passwords.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if password is None or username is None:
            return None

        # If the password doesn't look like a SHA-256 hash,
        # hash it first (this is the admin panel path)
        if len(password) != 64 or not all(c in "0123456789abcdef" for c in password):
            password = hashlib.sha256(password.encode()).hexdigest()

        # Now authenticate with the hashed password
        return super().authenticate(request, username=username, password=password, **kwargs)
