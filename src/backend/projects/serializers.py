from django.contrib.auth.models import User
from rest_framework import serializers
from .models import Project


class ProjectListSerializer(serializers.ModelSerializer):
    fork_count = serializers.IntegerField(source="forks.count", read_only=True)

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
        ]
        read_only_fields = fields


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
            "fork_of",
            "fork_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "edit_uuid",
            "view_uuid",
            "owner_name",
            "fork_of",
            "fork_count",
            "created_at",
            "updated_at",
        ]


class ProjectCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, default="Untitled Project")
    data = serializers.JSONField()


class UserRegistrationSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True, min_length=8)

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value


class UserLoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField()


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "username", "date_joined"]
        read_only_fields = fields
