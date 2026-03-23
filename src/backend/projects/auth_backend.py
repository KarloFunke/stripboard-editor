import hashlib
import re
from django.contrib.auth.backends import ModelBackend

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DualPasswordBackend(ModelBackend):
    """
    Authentication backend that handles both raw and SHA-256 pre-hashed passwords.

    The frontend SHA-256 hashes passwords before sending them to the API.
    Django stores pbkdf2(SHA256(raw_password)).

    - Frontend login: sends SHA256(raw) -> Django checks pbkdf2(SHA256(raw)) -> match
    - Admin login: sends raw -> this backend hashes it first -> Django checks pbkdf2(SHA256(raw)) -> match
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None or password is None:
            return None

        # Only pre-hash for admin panel requests (raw passwords)
        # API requests already arrive pre-hashed from the frontend
        is_admin = request and request.path.startswith("/admin/")

        if is_admin:
            password = hashlib.sha256(password.encode()).hexdigest()

        return super().authenticate(request, username=username, password=password, **kwargs)
