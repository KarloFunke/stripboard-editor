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


class Feedback(models.Model):
    message = models.TextField(max_length=4000)
    contact = models.CharField(max_length=200, blank=True)
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="feedback"
    )
    # When the owning user last viewed the thread; drives the "new reply" badge.
    user_last_seen = models.DateTimeField(null=True, blank=True)
    # When the site owner last opened the thread in the admin; drives the
    # "new user message" flag in the admin list.
    staff_last_seen = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.message[:60]


class FeedbackReply(models.Model):
    feedback = models.ForeignKey(
        Feedback, on_delete=models.CASCADE, related_name="replies"
    )
    # True = reply from the site owner, False = follow-up from the user
    from_staff = models.BooleanField(default=True)
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        who = "staff" if self.from_staff else "user"
        return f"{who}: {self.body[:50]}"
