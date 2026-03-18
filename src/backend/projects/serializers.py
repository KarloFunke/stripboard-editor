import re

from django.contrib.auth.models import User
from rest_framework import serializers
from .models import Project

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


MAX_PROJECT_DATA_BYTES = 512_000  # 500 KB


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
        return value


class UserRegistrationSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True)

    def validate_username(self, value):
        value = value.lower()
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value

    def validate_password(self, value):
        if not SHA256_PATTERN.match(value):
            raise serializers.ValidationError("Invalid credentials.")
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
        fields = ["id", "username", "date_joined"]
        read_only_fields = fields
