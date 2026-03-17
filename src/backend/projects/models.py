import uuid
from django.db import models
from django.contrib.auth.models import User


class Project(models.Model):
    edit_uuid = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)
    view_uuid = models.UUIDField(default=uuid.uuid4, unique=True, db_index=True)
    owner = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name="projects"
    )
    fork_of = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="forks"
    )
    name = models.CharField(max_length=255, default="Untitled Project")
    data = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["owner", "-updated_at"]),
            models.Index(fields=["fork_of"]),
        ]

    def __str__(self):
        return f"{self.name} ({self.edit_uuid})"


class PowChallenge(models.Model):
    challenge = models.CharField(max_length=64, unique=True, db_index=True)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["expires_at"]),
        ]

    def __str__(self):
        return self.challenge
