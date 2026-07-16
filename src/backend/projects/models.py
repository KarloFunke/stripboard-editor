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


class LayoutRating(models.Model):
    """A user's 1-5 rating of an auto-layout result, stored with a full snapshot
    of the project as the router left it so the layout can be reopened for
    evaluation later."""
    rating = models.PositiveSmallIntegerField()  # 1..5
    # Full project JSON, gzip-compressed. Ratings are expected in volume, so the
    # snapshot is stored compressed to keep disk use down. To read one: gzip
    # decompress the bytes, then json.loads.
    snapshot_gz = models.BinaryField()
    metrics = models.JSONField(default=dict, blank=True)
    solver_version = models.CharField(max_length=64, blank=True)
    # Deleting the account or the rated project takes its ratings with it.
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name="layout_ratings"
    )
    project = models.ForeignKey(
        Project, null=True, blank=True, on_delete=models.CASCADE, related_name="layout_ratings"
    )
    # Kept next to the FK so a rating can be traced to its project without a
    # join, and for ratings of projects that were never saved server-side.
    project_edit_uuid = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["solver_version", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.rating} stars ({self.solver_version or 'unknown'})"


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
