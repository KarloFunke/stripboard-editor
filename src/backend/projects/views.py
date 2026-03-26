import gzip
import hmac
import os
import sqlite3
import tempfile

from django.conf import settings as django_settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.contrib.sessions.models import Session
from django.http import FileResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response

from .models import Project
from .serializers import (
    ProjectListSerializer,
    ProjectDetailSerializer,
    ProjectViewSerializer,
    ProjectCreateSerializer,
    UserRegistrationSerializer,
    UserLoginSerializer,
    UserSerializer,
)
from .throttles import ProjectCreateThrottle, AuthThrottle, PowChallengeThrottle
from .pow import create_challenge, verify_and_consume, DIFFICULTY


# ── Projects ────────────────────────────────────────────


@api_view(["POST"])
@throttle_classes([ProjectCreateThrottle])
def project_create(request):
    # Require PoW for anonymous users
    if not request.user.is_authenticated:
        pow_challenge = request.data.get("pow_challenge")
        pow_nonce = request.data.get("pow_nonce")
        if not verify_and_consume(pow_challenge or "", pow_nonce or ""):
            return Response(
                {"error": "Invalid or missing proof of work"},
                status=status.HTTP_403_FORBIDDEN,
            )

    serializer = ProjectCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    project = Project.objects.create(
        name=serializer.validated_data["name"],
        data=serializer.validated_data["data"],
        owner=request.user if request.user.is_authenticated else None,
    )
    return Response(
        ProjectDetailSerializer(project).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["GET", "PUT", "DELETE"])
def project_detail(request, edit_uuid):
    try:
        project = Project.objects.get(edit_uuid=edit_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    if request.method == "GET":
        return Response(ProjectDetailSerializer(project).data)

    if request.method == "PUT":
        serializer = ProjectDetailSerializer(project, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    if request.method == "DELETE":
        if not request.user.is_authenticated or project.owner != request.user:
            return Response({"error": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        project.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
def project_view(request, view_uuid):
    try:
        project = Project.objects.get(view_uuid=view_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    return Response(ProjectViewSerializer(project).data)


@api_view(["POST"])
def project_fork(request, view_uuid):
    try:
        original = Project.objects.get(view_uuid=view_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    forked = Project.objects.create(
        name=f"{original.name} (fork)",
        data=original.data,
        owner=request.user if request.user.is_authenticated else None,
        fork_of=original,
    )
    return Response(
        ProjectDetailSerializer(forked).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def project_claim(request, edit_uuid):
    # Atomic: only claim if currently unowned
    updated = Project.objects.filter(
        edit_uuid=edit_uuid,
        owner__isnull=True,
    ).update(owner=request.user)

    if updated == 0:
        # Either doesn't exist or already owned
        if not Project.objects.filter(edit_uuid=edit_uuid).exists():
            return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {"error": "Project already has an owner"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    project = Project.objects.get(edit_uuid=edit_uuid)
    return Response(ProjectDetailSerializer(project).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_projects(request):
    projects = Project.objects.filter(owner=request.user)
    return Response(ProjectListSerializer(projects, many=True).data)


# ── Auth ────────────────────────────────────────────────


@api_view(["POST"])
@throttle_classes([AuthThrottle])
def auth_register(request):
    # Require PoW for registration
    pow_challenge = request.data.get("pow_challenge")
    pow_nonce = request.data.get("pow_nonce")
    if not verify_and_consume(pow_challenge or "", pow_nonce or ""):
        return Response(
            {"error": "Invalid or missing proof of work"},
            status=status.HTTP_403_FORBIDDEN,
        )

    serializer = UserRegistrationSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    user = User.objects.create_user(
        username=serializer.validated_data["username"],
        password=serializer.validated_data["password"],
    )
    login(request, user)
    return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@throttle_classes([AuthThrottle])
def auth_login(request):
    serializer = UserLoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    user = authenticate(
        request,
        username=serializer.validated_data["username"],
        password=serializer.validated_data["password"],
    )
    if user is None:
        return Response(
            {"error": "Invalid credentials"},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    login(request, user)
    return Response(UserSerializer(user).data)


@api_view(["POST"])
def auth_logout(request):
    logout(request)
    return Response({"ok": True})


def _clear_user_sessions(user_id, exclude_session_key=None):
    """Delete all active sessions for a user, optionally keeping one."""
    for session in Session.objects.filter(expire_date__gte=timezone.now()):
        try:
            data = session.get_decoded()
        except Exception:
            continue
        if str(data.get("_auth_user_id")) == str(user_id):
            if exclude_session_key and session.session_key == exclude_session_key:
                continue
            session.delete()


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthThrottle])
def auth_delete_account(request):
    user = request.user
    _clear_user_sessions(user.id)
    logout(request)
    user.delete()
    return Response({"ok": True}, status=status.HTTP_204_NO_CONTENT)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthThrottle])
def auth_change_password(request):
    new_password = request.data.get("new_password", "")

    if len(new_password) != 64 or not all(c in "0123456789abcdef" for c in new_password):
        return Response({"error": "Invalid credentials"}, status=status.HTTP_400_BAD_REQUEST)

    request.user.set_password(new_password)
    request.user.save()
    # Invalidate all other sessions, keep current
    _clear_user_sessions(request.user.id, exclude_session_key=request.session.session_key)
    login(request, request.user)
    return Response({"ok": True})


@api_view(["GET"])
def auth_me(request):
    if not request.user.is_authenticated:
        return Response({"user": None})
    return Response({"user": UserSerializer(request.user).data})


@api_view(["GET"])
def csrf_token(request):
    return Response({"csrfToken": get_token(request)})


@api_view(["GET"])
@throttle_classes([PowChallengeThrottle])
def pow_challenge(request):
    challenge = create_challenge()
    return Response({"challenge": challenge, "difficulty": DIFFICULTY})


@api_view(["GET"])
def db_backup(request):
    if not django_settings.BACKUP_TOKEN:
        return Response({"error": "Backup not configured"}, status=status.HTTP_501_NOT_IMPLEMENTED)

    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not hmac.compare_digest(token, django_settings.BACKUP_TOKEN):
        return Response(status=status.HTTP_403_FORBIDDEN)

    db_path = django_settings.DATABASES["default"]["NAME"]
    fd, backup_path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(fd)
    source = sqlite3.connect(db_path)
    dest = sqlite3.connect(backup_path)
    source.backup(dest)
    source.close()
    dest.close()

    gz_path = backup_path + ".gz"
    with open(backup_path, "rb") as f_in, gzip.open(gz_path, "wb") as f_out:
        f_out.writelines(f_in)
    os.unlink(backup_path)

    response = FileResponse(
        open(gz_path, "rb"),
        content_type="application/gzip",
        as_attachment=True,
        filename="db.sqlite3.gz",
    )
    os.unlink(gz_path)
    return response
