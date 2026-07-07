import gzip
import hmac
import logging
import os
import sqlite3
import tempfile

from django.conf import settings as django_settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.contrib.auth.tokens import default_token_generator
from django.contrib.sessions.models import Session
from django.core.mail import send_mail
from django.http import FileResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.encoding import force_bytes, force_str
from django.utils.html import escape
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.db.models import Count, F, Max, Q
from django.db.models.functions import Coalesce
from django.views.decorators.cache import cache_control
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework.response import Response

from .migrations_data.ic_unification import migrate_ic_unification
from .models import Project, Feedback
from .serializers import (
    ProjectListSerializer,
    ProjectDetailSerializer,
    ProjectViewSerializer,
    ProjectCreateSerializer,
    UserRegistrationSerializer,
    UserLoginSerializer,
    UserSerializer,
    EmailUpdateSerializer,
    FeedbackCreateSerializer,
    FeedbackThreadSerializer,
    FeedbackReplyCreateSerializer,
    AdminThreadListSerializer,
    AdminThreadDetailSerializer,
)
from .throttles import (
    ProjectCreateThrottle,
    AuthThrottle,
    PasswordResetThrottle,
    PowChallengeThrottle,
    FeedbackThrottle,
    FeedbackUserThrottle,
)
from .pow import create_challenge, verify_and_consume, DIFFICULTY

_log = logging.getLogger(__name__)


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
def project_migrate(request):
    """Stateless: takes a project data blob and returns the migrated version.
    Used by the frontend when importing a JSON file that may be on an older
    schema version. No DB read or write."""
    import json
    from .serializers import MAX_PROJECT_DATA_BYTES

    data = request.data
    if not isinstance(data, dict):
        return Response({"error": "Expected an object"}, status=status.HTTP_400_BAD_REQUEST)

    size = len(json.dumps(data).encode("utf-8"))
    if size > MAX_PROJECT_DATA_BYTES:
        return Response(
            {"error": f"Project data too large ({size} bytes). Maximum is {MAX_PROJECT_DATA_BYTES} bytes."},
            status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )

    migrated, _ = migrate_ic_unification(data)
    return Response(migrated)


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


@cache_control(private=True, no_store=True)
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
        email=serializer.validated_data.get("email", ""),
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


@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([AuthThrottle])
def auth_set_email(request):
    """Set or clear the current user's email (used for password reset). Optional
    and unverified."""
    serializer = EmailUpdateSerializer(data=request.data, context={"user": request.user})
    serializer.is_valid(raise_exception=True)
    request.user.email = serializer.validated_data["email"]
    request.user.save(update_fields=["email"])
    return Response(UserSerializer(request.user).data)


def _send_password_reset_email(user):
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = default_token_generator.make_token(user)
    link = f"{django_settings.FRONTEND_URL}/reset-password?uid={uid}&token={token}"
    subject = "Reset your Stripboard Editor password"
    message = (
        f"Hi {user.username},\n\n"
        "We received a request to reset your Stripboard Editor password.\n"
        "Use the link below to choose a new password (valid for 1 hour):\n"
        f"{link}\n\n"
        "If you didn't request this, you can safely ignore this email.\n"
    )
    # HTML alternative so the link is clickable in every client (not all clients
    # auto-linkify bare URLs). escape() also turns "&" into "&amp;" for a valid href.
    safe_user = escape(user.username)
    safe_link = escape(link)
    html_message = (
        f"<p>Hi {safe_user},</p>"
        "<p>We received a request to reset your Stripboard Editor password.</p>"
        f'<p><a href="{safe_link}">Choose a new password</a> (valid for 1 hour).</p>'
        "<p>If you didn't request this, you can safely ignore this email.</p>"
    )
    send_mail(
        subject,
        message,
        django_settings.DEFAULT_FROM_EMAIL,
        [user.email],
        html_message=html_message,
        fail_silently=False,
    )


@api_view(["POST"])
@throttle_classes([PasswordResetThrottle])
def auth_password_reset_request(request):
    """Email a reset link to every active account with this address. Tells the
    caller when no account matches. Email existence is already discoverable via
    the registration/set-email uniqueness checks, so hiding it here adds nothing."""
    # Require PoW to make bulk emailing (and Resend-quota exhaustion) expensive.
    pow_challenge = request.data.get("pow_challenge")
    pow_nonce = request.data.get("pow_nonce")
    if not verify_and_consume(pow_challenge or "", pow_nonce or ""):
        return Response(
            {"error": "Invalid or missing proof of work"},
            status=status.HTTP_403_FORBIDDEN,
        )

    email = (request.data.get("email") or "").strip().lower()
    users = list(User.objects.filter(email__iexact=email, is_active=True)) if email else []
    if not users:
        return Response(
            {"error": "No account is registered with that email."},
            status=status.HTTP_404_NOT_FOUND,
        )

    try:
        for user in users:
            _send_password_reset_email(user)
    except Exception:
        _log.exception("Failed to send password reset email")
        return Response(
            {"error": "Could not send the reset email. Please try again in a moment."},
            status=status.HTTP_502_BAD_GATEWAY,
        )
    return Response({"ok": True})


@api_view(["POST"])
@throttle_classes([PasswordResetThrottle])
def auth_password_reset_confirm(request):
    """Validate the reset token and set a new (client-hashed) password, then log
    the user in on the fresh session."""
    uid = request.data.get("uid", "")
    token = request.data.get("token", "")
    new_password = request.data.get("new_password", "")

    if len(new_password) != 64 or not all(c in "0123456789abcdef" for c in new_password):
        return Response({"error": "Invalid password"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        user = User.objects.get(pk=force_str(urlsafe_base64_decode(uid)))
    except (User.DoesNotExist, ValueError, TypeError, OverflowError):
        return Response(
            {"error": "Invalid or expired reset link"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # A reset link must not resurrect a deactivated account. login() below sets
    # the session directly (unlike authenticate(), it doesn't gate on is_active),
    # so guard here. Same generic error as a bad token, to avoid leaking state.
    if not user.is_active:
        return Response(
            {"error": "Invalid or expired reset link"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Check the token before changing the password, the token is derived from
    # the current password hash, so it must be validated against the old one.
    if not default_token_generator.check_token(user, token):
        return Response(
            {"error": "Invalid or expired reset link"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    user.set_password(new_password)
    user.save()
    _clear_user_sessions(user.id)
    login(request, user, backend="projects.auth_backend.DualPasswordBackend")
    return Response(UserSerializer(user).data)


@cache_control(private=True, no_store=True)
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


# ── Feedback ────────────────────────────────────────────

def _user_thread(user):
    """The single continuous feedback thread for a logged-in user, if any."""
    return Feedback.objects.filter(user=user).order_by("created_at").first()


@api_view(["POST"])
@throttle_classes([FeedbackThrottle, FeedbackUserThrottle])
def feedback_create(request):
    serializer = FeedbackCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    message = serializer.validated_data["message"]

    # Logged-in users have one continuous thread: the first message creates it,
    # every later message (from them) appends as a reply. No PoW needed.
    if request.user.is_authenticated:
        thread = _user_thread(request.user)
        if thread is None:
            Feedback.objects.create(message=message, user=request.user)
        else:
            thread.replies.create(from_staff=False, body=message)
        return Response({"ok": True}, status=status.HTTP_201_CREATED)

    # Anonymous: each submission is its own one-off thread, gated by PoW.
    pow_challenge = request.data.get("pow_challenge")
    pow_nonce = request.data.get("pow_nonce")
    if not verify_and_consume(pow_challenge or "", pow_nonce or ""):
        return Response(
            {"error": "Invalid or missing proof of work"},
            status=status.HTTP_403_FORBIDDEN,
        )
    Feedback.objects.create(
        message=message,
        contact=serializer.validated_data.get("contact", ""),
        user=None,
    )
    return Response({"ok": True}, status=status.HTTP_201_CREATED)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def feedback_mine(request):
    thread = _user_thread(request.user)
    if thread is None:
        return Response(None)
    data = FeedbackThreadSerializer(thread).data
    # Viewing the thread marks it seen, clearing the unread badge.
    thread.user_last_seen = timezone.now()
    thread.save(update_fields=["user_last_seen"])
    return Response(data)


# ── Staff inbox (the /inbox page; IsAdminUser-gated) ────

def _annotated_threads():
    # last_activity: newest message in the thread. last_user_msg: newest message
    # from the user only (the opening message is always theirs).
    return Feedback.objects.annotate(
        last_activity=Coalesce(Max("replies__created_at"), F("created_at")),
        last_user_msg=Coalesce(
            Max("replies__created_at", filter=Q(replies__from_staff=False)),
            F("created_at"),
        ),
    )


@api_view(["GET"])
@permission_classes([IsAdminUser])
def feedback_admin_threads(request):
    threads = (
        _annotated_threads()
        .annotate(reply_count=Count("replies"))
        .order_by("-last_activity")
    )
    return Response(AdminThreadListSerializer(threads, many=True).data)


@api_view(["GET"])
@permission_classes([IsAdminUser])
def feedback_admin_thread(request, pk):
    try:
        thread = Feedback.objects.get(pk=pk)
    except Feedback.DoesNotExist:
        return Response(status=status.HTTP_404_NOT_FOUND)
    data = AdminThreadDetailSerializer(thread).data
    # Opening a thread marks its user messages seen.
    Feedback.objects.filter(pk=pk).update(staff_last_seen=timezone.now())
    return Response(data)


@api_view(["POST"])
@permission_classes([IsAdminUser])
def feedback_admin_reply(request, pk):
    try:
        thread = Feedback.objects.get(pk=pk)
    except Feedback.DoesNotExist:
        return Response(status=status.HTTP_404_NOT_FOUND)
    serializer = FeedbackReplyCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    thread.replies.create(from_staff=True, body=serializer.validated_data["body"])
    thread.staff_last_seen = timezone.now()
    thread.save(update_fields=["staff_last_seen"])
    return Response(
        AdminThreadDetailSerializer(thread).data, status=status.HTTP_201_CREATED
    )


# ── Site header (one always-200 call for the whole header) ──

@api_view(["GET"])
def header_state(request):
    """Backs the site header in a single request: the current user (or null) plus
    the two unread indicators, computed for whoever is or isn't logged in. Always
    200 so the header never makes failing 401/403 calls."""
    user = request.user if request.user.is_authenticated else None

    feedback_unread = False
    inbox_unread = 0
    if user is not None:
        thread = _user_thread(user)
        if thread is not None:
            staff_replies = thread.replies.filter(from_staff=True)
            if thread.user_last_seen:
                feedback_unread = staff_replies.filter(created_at__gt=thread.user_last_seen).exists()
            else:
                feedback_unread = staff_replies.exists()
        if user.is_staff:
            inbox_unread = _annotated_threads().filter(
                Q(staff_last_seen__isnull=True) | Q(last_user_msg__gt=F("staff_last_seen"))
            ).count()

    return Response({
        "user": UserSerializer(user).data if user is not None else None,
        "feedbackUnread": feedback_unread,
        "inboxUnread": inbox_unread,
    })


@api_view(["GET"])
@permission_classes([AllowAny])
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
