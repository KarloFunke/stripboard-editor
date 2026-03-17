"""
Proof-of-Work challenge system using database storage.

Flow:
1. Client requests GET /api/pow/challenge/ → { challenge, difficulty }
2. Client finds nonce where SHA256(challenge + nonce) starts with `difficulty` zero hex chars
3. Client sends { pow_challenge, pow_nonce } alongside the protected request
4. Server verifies the solution and deletes the challenge (one-time use)

Difficulty 4 = ~65K hashes ≈ 50-200ms on a modern browser.
"""

import hashlib
import secrets

from django.utils import timezone
from datetime import timedelta

CHALLENGE_TTL = timedelta(minutes=5)
DIFFICULTY = 3  # number of leading zero hex chars required


def create_challenge() -> str:
    """Generate a new PoW challenge and store it in the database."""
    from .models import PowChallenge

    # Clean up expired challenges opportunistically
    PowChallenge.objects.filter(expires_at__lt=timezone.now()).delete()

    challenge = secrets.token_hex(16)
    PowChallenge.objects.create(
        challenge=challenge,
        expires_at=timezone.now() + CHALLENGE_TTL,
    )
    return challenge


def verify_and_consume(challenge: str, nonce: str) -> bool:
    """
    Verify a PoW solution and consume the challenge (one-time use).
    Returns True if valid, False otherwise.
    """
    if not challenge or not nonce:
        return False

    from .models import PowChallenge

    # Atomically fetch and delete the challenge
    deleted_count, _ = PowChallenge.objects.filter(
        challenge=challenge,
        expires_at__gt=timezone.now(),
    ).delete()

    if deleted_count == 0:
        return False  # unknown, already consumed, or expired

    # Verify the hash
    digest = hashlib.sha256((challenge + nonce).encode()).hexdigest()
    return digest[:DIFFICULTY] == "0" * DIFFICULTY
