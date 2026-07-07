import logging
import re

from django.contrib.auth.models import User
from rest_framework import serializers
from .migrations_data.ic_unification import migrate_ic_unification
from .models import Project, Feedback, FeedbackReply

_log = logging.getLogger(__name__)

# SHA-256 hex digest: exactly 64 lowercase hex characters
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

# Strip HTML tags from project names
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")


def sanitize_name(value: str) -> str:
    """Remove HTML tags and excessive whitespace from project names."""
    cleaned = HTML_TAG_PATTERN.sub("", value).strip()
    if not cleaned:
        return "Untitled Project"
    return cleaned


class ProjectListSerializer(serializers.ModelSerializer):
    fork_count = serializers.IntegerField(source="forks.count", read_only=True)
    preview_data = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            "edit_uuid",
            "view_uuid",
            "name",
            "fork_of",
            "fork_count",
            "created_at",
            "updated_at",
            "preview_data",
        ]
        read_only_fields = fields

    def get_preview_data(self, obj):
        """Extract minimal data needed for stripboard preview thumbnail."""
        data = obj.data or {}
        components = data.get("components", [])
        placed = [c for c in components if c.get("boardPos") is not None]
        if not placed:
            return None
        return {
            "components": placed,
            "componentDefs": data.get("componentDefs", []),
            "board": data.get("board", {}),
            "nets": data.get("nets", []),
            "netAssignments": data.get("netAssignments", []),
        }


class ProjectDetailSerializer(serializers.ModelSerializer):
    fork_count = serializers.IntegerField(source="forks.count", read_only=True)
    owner_name = serializers.CharField(source="owner.username", read_only=True, default=None)

    class Meta:
        model = Project
        fields = [
            "edit_uuid",
            "view_uuid",
            "name",
            "data",
            "owner_name",
            "fork_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "edit_uuid",
            "view_uuid",
            "owner_name",
            "fork_count",
            "created_at",
            "updated_at",
        ]

    def validate_data(self, value):
        import json
        size = len(json.dumps(value).encode("utf-8"))
        if size > MAX_PROJECT_DATA_BYTES:
            raise serializers.ValidationError(
                f"Project data too large ({size} bytes). Maximum is {MAX_PROJECT_DATA_BYTES} bytes."
            )
        try:
            migrated, _ = migrate_ic_unification(value)
            return migrated
        except Exception:
            _log.exception("ic_unification save-hook failed for incoming PUT")
            return value


class ProjectViewSerializer(serializers.ModelSerializer):
    """Read-only serializer for view-only access. Minimal fields, no edit_uuid."""
    owner_name = serializers.CharField(source="owner.username", read_only=True, default=None)

    class Meta:
        model = Project
        fields = [
            "view_uuid",
            "name",
            "data",
            "owner_name",
        ]
        read_only_fields = fields

    def validate_name(self, value):
        return sanitize_name(value)

    def validate_data(self, value):
        import json
        size = len(json.dumps(value).encode("utf-8"))
        if size > MAX_PROJECT_DATA_BYTES:
            raise serializers.ValidationError(
                f"Project data too large ({size} bytes). Maximum is {MAX_PROJECT_DATA_BYTES} bytes."
            )
        return value


MAX_PROJECT_DATA_BYTES = 1024_000  # 1MB


class ProjectCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, default="Untitled Project")
    data = serializers.JSONField()

    def validate_name(self, value):
        return sanitize_name(value)

    def validate_data(self, value):
        import json
        size = len(json.dumps(value).encode("utf-8"))
        if size > MAX_PROJECT_DATA_BYTES:
            raise serializers.ValidationError(
                f"Project data too large ({size} bytes). Maximum is {MAX_PROJECT_DATA_BYTES} bytes."
            )
        try:
            migrated, _ = migrate_ic_unification(value)
            return migrated
        except Exception:
            _log.exception("ic_unification create-hook failed")
            return value


class UserRegistrationSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True)
    # Optional: enables password reset later. Not verified.
    email = serializers.EmailField(required=False, allow_blank=True, default="")

    def validate_username(self, value):
        value = value.lower()
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value

    def validate_password(self, value):
        if not SHA256_PATTERN.match(value):
            raise serializers.ValidationError("Invalid credentials.")
        return value

    def validate_email(self, value):
        value = value.strip().lower()
        # Enforce uniqueness at the app layer (Django's User.email isn't unique).
        # Blank is exempt: any number of accounts may have no recovery email.
        if value and User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("This email is already in use.")
        return value


class EmailUpdateSerializer(serializers.Serializer):
    # Blank clears the address (opting out of password reset).
    email = serializers.EmailField(required=False, allow_blank=True, default="")

    def validate_email(self, value):
        value = value.strip().lower()
        if value:
            qs = User.objects.filter(email__iexact=value)
            # Allow re-saving the caller's own address unchanged.
            user = self.context.get("user")
            if user is not None:
                qs = qs.exclude(pk=user.pk)
            if qs.exists():
                raise serializers.ValidationError("This email is already in use.")
        return value


class UserLoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField()

    def validate_username(self, value):
        return value.lower()

    def validate_password(self, value):
        if not SHA256_PATTERN.match(value):
            raise serializers.ValidationError("Invalid credentials.")
        return value


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "email", "date_joined", "is_staff"]
        read_only_fields = fields


class FeedbackCreateSerializer(serializers.Serializer):
    message = serializers.CharField(max_length=4000, trim_whitespace=True)
    contact = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )


class FeedbackReplySerializer(serializers.ModelSerializer):
    class Meta:
        model = FeedbackReply
        fields = ["body", "from_staff", "created_at"]
        read_only_fields = fields


class FeedbackThreadSerializer(serializers.ModelSerializer):
    replies = FeedbackReplySerializer(many=True, read_only=True)

    class Meta:
        model = Feedback
        fields = ["id", "message", "created_at", "replies"]
        read_only_fields = fields


class FeedbackReplyCreateSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=4000, trim_whitespace=True)


# ── Staff-side feedback (the /inbox page) ──────────────

class AdminThreadListSerializer(serializers.ModelSerializer):
    """One row in the staff inbox list. Relies on last_activity/last_user_msg
    annotations added by the view."""
    username = serializers.CharField(source="user.username", default=None, read_only=True)
    reply_count = serializers.IntegerField(read_only=True)  # annotated in the view
    last_activity = serializers.DateTimeField(read_only=True)
    unseen = serializers.SerializerMethodField()

    class Meta:
        model = Feedback
        fields = [
            "id", "username", "contact", "message",
            "created_at", "last_activity", "reply_count", "unseen",
        ]
        read_only_fields = fields

    def get_unseen(self, obj):
        return obj.staff_last_seen is None or obj.last_user_msg > obj.staff_last_seen


class AdminThreadDetailSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source="user.username", default=None, read_only=True)
    replies = FeedbackReplySerializer(many=True, read_only=True)

    class Meta:
        model = Feedback
        fields = ["id", "username", "contact", "message", "created_at", "replies"]
        read_only_fields = fields
