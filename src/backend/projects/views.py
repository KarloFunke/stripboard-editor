from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.middleware.csrf import get_token
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response

from .models import Project
from .serializers import (
    ProjectListSerializer,
    ProjectDetailSerializer,
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
        project.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
def project_view(request, view_uuid):
    try:
        project = Project.objects.get(view_uuid=view_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    return Response(ProjectDetailSerializer(project).data)


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
    try:
        project = Project.objects.get(edit_uuid=edit_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    if project.owner is not None:
        return Response(
            {"error": "Project already has an owner"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    project.owner = request.user
    project.save(update_fields=["owner"])
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


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthThrottle])
def auth_delete_account(request):
    user = request.user
    logout(request)
    user.delete()  # Projects kept via SET_NULL on FK
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
