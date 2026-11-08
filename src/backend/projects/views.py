import copy
import gzip
import hmac
import json
import logging
import os
import sqlite3
import tempfile
from datetime import datetime

from django.conf import settings as django_settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import User
from django.contrib.auth.tokens import default_token_generator
from django.contrib.sessions.models import Session
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.mail import send_mail
from django.http import FileResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.encoding import force_bytes, force_str
from django.utils.html import escape
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.db import transaction
from django.db.models import Count, F, Max, Q
from django.db.models.functions import Coalesce
from django.views.decorators.cache import cache_control
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework.response import Response

from .branches import (
    MAX_BRANCH_NAME, MAX_BRANCHES_PER_PROJECT, clean_data, copy_history, gz, history_json, merge_pair,
    readable, ungz, version as branch_version,
)
from .migrations_data.pipeline import migrate_to_current
from .models import Branch, BranchMerge, Project, Feedback, LayoutRating, UserBoard, UserPart
from .serializers import (
    HTML_TAG_PATTERN,
    ProjectListSerializer,
    ProjectCreateSerializer,
    sanitize_name,
    UserRegistrationSerializer,
    UserLoginSerializer,
    UserSerializer,
    EmailUpdateSerializer,
    FeedbackCreateSerializer,
    FeedbackThreadSerializer,
    FeedbackReplyCreateSerializer,
    AdminThreadListSerializer,
    AdminThreadDetailSerializer,
    LayoutRatingCreateSerializer,
)
from .throttles import (
    ProjectCreateThrottle,
    ProjectMigrateThrottle,
    AuthThrottle,
    PasswordResetThrottle,
    PowChallengeThrottle,
    FeedbackThrottle,
    FeedbackUserThrottle,
    LayoutRatingThrottle,
    LayoutRatingUserThrottle,
)
from .pow import create_challenge, verify_and_consume, DIFFICULTY
from .user_parts import (
    MAX_PARTS_PER_USER, apply_to_project, found_in_projects, link_copies, linked_copies, placed_count,
    stored_part, validate_part,
)
from . import user_boards

_log = logging.getLogger(__name__)


# ── Projects ────────────────────────────────────────────

MAX_PROJECTS_PER_USER = 500
PROJECTS_PAGE_SIZE = 10


def _project_limit_response(user):
    """A 403 when a signed-in user already owns as many projects as allowed."""
    if user.is_authenticated and Project.objects.filter(owner=user).count() >= MAX_PROJECTS_PER_USER:
        return Response(
            {"error": f"You have reached the limit of {MAX_PROJECTS_PER_USER} projects. Delete one to make room."},
            status=status.HTTP_403_FORBIDDEN,
        )
    return None


def _find_branch(project, branch_id, default):
    """The project's branch `branch_id` ("active" for the one last worked on),
    `default` when none is asked for, or None when it is not one of its own."""
    if not branch_id:
        return default
    if branch_id == "active":
        return project.active_branch or project.main_branch
    try:
        return project.branches.get(id=branch_id)
    except (Branch.DoesNotExist, DjangoValidationError, ValueError):
        return None


# `code` lets the editor tell a branch that is gone from other failures: a
# branch merged or deleted in another tab cannot take this tab's saves
def _branch_not_found():
    return Response({"error": "Branch not found", "code": "branch_missing"}, status=status.HTTP_404_NOT_FOUND)


def _branch_closed(branch):
    return Response(
        {"error": f'"{branch.name}" was merged and is closed', "code": "branch_closed"},
        status=status.HTTP_400_BAD_REQUEST,
    )


def _upstream_json(project):
    """For a fork: the original project, by its view link only."""
    main = project.main_branch
    up = main.parent if main is not None else None
    if up is None or up.project_id == project.id:
        return None
    return {"view_uuid": str(up.project.view_uuid), "name": up.project.name, "branch": str(up.id)}


def _detail_json(project, branch):
    """What the editor gets: one branch's design and the project's history."""
    return {
        "edit_uuid": str(project.edit_uuid),
        "view_uuid": str(project.view_uuid),
        "name": project.name,
        "owner_name": project.owner.username if project.owner else None,
        "fork_count": project.forks.count(),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "branch": str(branch.id),
        "branch_version": branch_version(branch),
        "data": readable(branch.data, project.name),
        "main_branch": str(project.main_branch_id),
        "active_branch": str(project.active_branch_id or project.main_branch_id),
        "upstream": _upstream_json(project),
        **history_json(project),
    }


def _view_json(project, branch):
    """What a view link gets: no edit uuid, and no link to a fork's original."""
    return {
        "view_uuid": str(project.view_uuid),
        "name": project.name,
        "owner_name": project.owner.username if project.owner else None,
        "branch": str(branch.id),
        "data": readable(branch.data, project.name),
        "main_branch": str(project.main_branch_id),
        **history_json(project),
    }


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

    limit = _project_limit_response(request.user)
    if limit:
        return limit

    serializer = ProjectCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    project = Project.create_with_main(
        serializer.validated_data["data"],
        name=serializer.validated_data["name"],
        owner=request.user if request.user.is_authenticated else None,
    )
    return Response(_detail_json(project, project.main_branch), status=status.HTTP_201_CREATED)


@api_view(["GET", "PUT", "DELETE"])
def project_detail(request, edit_uuid):
    """One branch of a project: `branch` names it ("active" for the one last
    worked on). Without it this is the main branch, which keeps editors
    loaded before branches existed reading and saving the branch they know."""
    try:
        project = Project.objects.select_related("main_branch", "active_branch", "owner").get(edit_uuid=edit_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)

    if request.method == "GET":
        branch = _find_branch(project, request.query_params.get("branch"), project.main_branch)
        if branch is None:
            return _branch_not_found()
        return Response(_detail_json(project, branch))

    if request.method == "PUT":
        branch = _find_branch(project, request.data.get("branch"), project.main_branch)
        if branch is None:
            return _branch_not_found()
        if branch.closed_at is not None:
            return _branch_closed(branch)
        name = request.data.get("name")
        if isinstance(name, str):
            project.name = sanitize_name(name)[:255]
        if "data" in request.data:
            branch.data = clean_data(request.data["data"])
            branch.save(update_fields=["data", "updated_at"])
        # Saving a branch makes it the one the editor reopens
        project.active_branch = branch
        project.save(update_fields=["name", "active_branch", "updated_at"])
        # Autosave sends this every second: the history, not the design back
        return Response({
            "branch": str(branch.id),
            "branch_version": branch_version(branch),
            "updated_at": project.updated_at,
            **history_json(project),
        })

    if request.method == "DELETE":
        if not request.user.is_authenticated or project.owner != request.user:
            return Response({"error": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)
        project.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
def project_view(request, view_uuid):
    """A view link shows the main branch; `branch` picks another to look at."""
    try:
        project = Project.objects.select_related("main_branch", "owner").get(view_uuid=view_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    branch = _find_branch(project, request.query_params.get("branch"), project.main_branch)
    if branch is None or request.query_params.get("branch") == "active":
        return _branch_not_found()
    return Response(_view_json(project, branch))


@api_view(["POST"])
@throttle_classes([ProjectMigrateThrottle])
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

    migrated, _ = migrate_to_current(data)
    return Response(migrated)


@api_view(["POST"])
def project_fork(request, view_uuid):
    try:
        original = Project.objects.get(view_uuid=view_uuid)
    except Project.DoesNotExist:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    limit = _project_limit_response(request.user)
    if limit:
        return limit

    # The fork's main starts as the original's main and keeps it as its
    # parent, so the original's later changes can be taken in.
    upstream = original.main_branch
    data, _ = migrate_to_current(copy.deepcopy(upstream.data))
    with transaction.atomic():
        forked = Project.create_with_main(
            data,
            name=f"{original.name[:248]} (fork)",
            owner=request.user if request.user.is_authenticated else None,
            fork_of=original,
        )
        main = forked.main_branch
        main.parent = upstream
        main.base_gz = gz(upstream.data)
        main.save(update_fields=["parent", "base_gz"])
    return Response(_detail_json(forked, main), status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def project_claim(request, edit_uuid):
    limit = _project_limit_response(request.user)
    if limit:
        return limit
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
    return Response(_detail_json(project, project.main_branch))


def _owned_project(request, edit_uuid):
    """The signed-in user's own project, or None."""
    return Project.objects.filter(edit_uuid=edit_uuid, owner=request.user).first()


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def project_duplicate(request, edit_uuid):
    original = _owned_project(request, edit_uuid)
    if original is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    limit = _project_limit_response(request.user)
    if limit:
        return limit

    requested = request.data.get("name")
    name = sanitize_name(requested)[:255] if isinstance(requested, str) else f"{original.name[:248]} (copy)"
    # A copy carries the whole history; a copy of a fork still follows the original
    with transaction.atomic():
        duplicate = Project.objects.create(name=name, owner=request.user, fork_of=original.fork_of)
        copy_history(original, duplicate)
    return Response(ProjectListSerializer(duplicate).data, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def project_rename(request, edit_uuid):
    project = _owned_project(request, edit_uuid)
    if project is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    name = request.data.get("name")
    if not isinstance(name, str):
        return Response({"error": "Expected a name"}, status=status.HTTP_400_BAD_REQUEST)

    # The name belongs to the project; every branch's data is served with it
    project.name = sanitize_name(name)[:255]
    project.save(update_fields=["name", "updated_at"])
    return Response({"name": project.name})


@cache_control(private=True, no_store=True)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_projects(request):
    """One page of the user's projects, most recently updated first. `before`
    is the `next` cursor of the previous page: keyed on (updated_at, id), so
    projects created or deleted meanwhile do not shift the pages."""
    try:
        limit = min(max(int(request.query_params.get("limit", PROJECTS_PAGE_SIZE)), 1), 100)
    except ValueError:
        limit = PROJECTS_PAGE_SIZE
    projects = (
        Project.objects.filter(owner=request.user)
        .select_related("active_branch", "main_branch")
        .order_by("-updated_at", "-id")
    )
    before = request.query_params.get("before")
    if before:
        try:
            at, _, pk = before.rpartition("_")
            at = datetime.fromisoformat(at)
            projects = projects.filter(Q(updated_at__lt=at) | Q(updated_at=at, id__lt=int(pk)))
        except ValueError:
            return Response({"error": "Invalid cursor"}, status=status.HTTP_400_BAD_REQUEST)
    page = list(projects[: limit + 1])
    has_more = len(page) > limit
    page = page[:limit]
    return Response({
        "results": ProjectListSerializer(page, many=True).data,
        "next": f"{page[-1].updated_at.isoformat()}_{page[-1].id}" if has_more else None,
    })


# ── Branches ────────────────────────────────────────────
# Anyone holding the edit link manages a project's branches, as they edit it.


def _edit_project(edit_uuid):
    return (
        Project.objects.select_related("main_branch", "active_branch", "owner")
        .filter(edit_uuid=edit_uuid).first()
    )


def _branch_name(project, value, exclude=None):
    """A clean, unused branch name, or an error message."""
    if not isinstance(value, str):
        return None, "Expected a name"
    name = HTML_TAG_PATTERN.sub("", value).strip()[:MAX_BRANCH_NAME]
    if not name:
        return None, "The name is empty"
    taken = project.branches.filter(name__iexact=name)
    if exclude is not None:
        taken = taken.exclude(pk=exclude.pk)
    if taken.exists():
        return None, f'There already is a branch called "{name}"'
    return name, None


@api_view(["POST"])
def branch_create(request, edit_uuid):
    """A new branch starting from `from`, holding a copy of its design."""
    project = _edit_project(edit_uuid)
    if project is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    # Merged branches are history: they do not take up room
    if project.branches.filter(closed_at__isnull=True).count() >= MAX_BRANCHES_PER_PROJECT:
        return Response(
            {"error": f"A project can have at most {MAX_BRANCHES_PER_PROJECT} branches. Delete one to make room."},
            status=status.HTTP_403_FORBIDDEN,
        )
    source = _find_branch(project, request.data.get("from"), None)
    if source is None:
        return _branch_not_found()
    if source.closed_at is not None:
        return _branch_closed(source)
    name, error = _branch_name(project, request.data.get("name"))
    if error:
        return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
    with transaction.atomic():
        branch = Branch.objects.create(
            project=project, name=name, data=copy.deepcopy(source.data), parent=source, base_gz=gz(source.data),
        )
        project.active_branch = branch
        project.save(update_fields=["active_branch", "updated_at"])
    return Response(_detail_json(project, branch), status=status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
def branch_detail(request, edit_uuid, branch_id):
    project = _edit_project(edit_uuid)
    if project is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    branch = _find_branch(project, str(branch_id), None)
    if branch is None:
        return _branch_not_found()
    if branch.id == project.main_branch_id:
        return Response({"error": "The main branch cannot be renamed or deleted"}, status=status.HTTP_400_BAD_REQUEST)

    if request.method == "PATCH":
        name, error = _branch_name(project, request.data.get("name"), exclude=branch)
        if error:
            return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
        # A rename is not an edit: it leaves the branch's version alone
        Branch.objects.filter(pk=branch.pk).update(name=name)
        return Response(history_json(project))

    # A merged branch is history: it goes only with the branch it was merged into
    if branch.closed_at is not None:
        return _branch_closed(branch)
    # An open branch started from this one would be left without a parent to merge with
    if branch.children.filter(project=project, closed_at__isnull=True).exists():
        return Response(
            {"error": "Other branches start from this one. Delete or merge them first."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    with transaction.atomic():
        if project.active_branch_id == branch.id:
            project.active_branch = project.main_branch
            project.save(update_fields=["active_branch"])
        Branch.objects.filter(id__in=_with_merged_branches(project, branch)).delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


def _with_merged_branches(project, branch):
    """The branch and every merged branch under it, however deep: a merged
    branch is kept only as the history of the branch it was merged into."""
    ids, todo = [branch.id], [branch.id]
    while todo:
        todo = list(
            Branch.objects.filter(project=project, parent_id__in=todo, closed_at__isnull=False).values_list("id", flat=True)
        )
        ids += todo
    return ids


@api_view(["POST"])
def branch_activate(request, edit_uuid, branch_id):
    """Switching to a branch makes it the one the editor reopens."""
    project = _edit_project(edit_uuid)
    if project is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    branch = _find_branch(project, str(branch_id), None)
    if branch is None:
        return _branch_not_found()
    if branch.closed_at is not None:
        return _branch_closed(branch)
    Project.objects.filter(pk=project.pk).update(active_branch=branch)
    return Response(status=status.HTTP_204_NO_CONTENT)


def _merge_source(target, source_id):
    """The branch `source_id`, when it can merge into `target`: the target's
    parent (for a fork's main, in the original project) or one of the
    target's own branches."""
    try:
        source = Branch.objects.select_related("project").get(id=source_id)
    except (Branch.DoesNotExist, DjangoValidationError, ValueError, TypeError):
        return None, None
    kind = merge_pair(target, source)
    return (source, kind) if kind else (None, None)


def _merge_refusal(project, target, source, kind):
    """Why these two cannot be merged now, or None."""
    for b in (target, source):
        if b.closed_at is not None:
            return _branch_closed(b)
    # Merging into the parent closes the branch: branches started from it
    # would be left without a parent to merge with
    if kind == "into-parent" and source.children.filter(project=project, closed_at__isnull=True).exists():
        return Response(
            {"error": f'Other branches start from "{source.name}". Merge or delete them first.'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    return None


def _merge_base(target, source, kind):
    return ungz(target.base_gz if kind == "from-parent" else source.base_gz)


@api_view(["GET", "POST"])
def branch_merge(request, edit_uuid, branch_id):
    """GET: the three states a merge of `source` into this branch works on
    (their last common state and both branches now). POST: the merged design
    the editor worked out, saved to this branch. The merge is refused when
    either branch changed since the GET, so nothing saved meanwhile is lost."""
    project = _edit_project(edit_uuid)
    if project is None:
        return Response({"error": "Project not found"}, status=status.HTTP_404_NOT_FOUND)
    target = _find_branch(project, str(branch_id), None)
    if target is None:
        return _branch_not_found()
    params = request.query_params if request.method == "GET" else request.data
    source, kind = _merge_source(target, params.get("source"))
    if source is None:
        return Response({"error": "These branches cannot be merged"}, status=status.HTTP_400_BAD_REQUEST)
    refusal = _merge_refusal(project, target, source, kind)
    if refusal:
        return refusal

    if request.method == "GET":
        base = _merge_base(target, source, kind)
        if base is None:
            return Response({"error": "These branches have no common state"}, status=status.HTTP_409_CONFLICT)
        return Response({
            "kind": kind,
            "base": readable(base, project.name),
            "source": {"id": str(source.id), "name": source.name, "version": branch_version(source),
                       "data": readable(source.data, project.name)},
            "target": {"id": str(target.id), "name": target.name, "version": branch_version(target),
                       "data": readable(target.data, project.name)},
        })

    data = clean_data(request.data.get("data"))
    with transaction.atomic():
        locked = {b.id: b for b in Branch.objects.select_for_update().filter(id__in=[source.id, target.id])}
        if source.id not in locked or target.id not in locked:
            return Response(
                {"error": "A branch was deleted while merging.", "code": "branch_missing"},
                status=status.HTTP_409_CONFLICT,
            )
        source, target = locked[source.id], locked[target.id]
        # Checked again under the lock: another tab may have merged or branched meanwhile
        refusal = _merge_refusal(project, target, source, kind)
        if refusal:
            return refusal
        if (branch_version(source) != request.data.get("source_version")
                or branch_version(target) != request.data.get("target_version")):
            return Response(
                {"error": "A branch changed while merging. Start the merge again."},
                status=status.HTTP_409_CONFLICT,
            )
        target.data = data
        target.save(update_fields=["data", "updated_at"])
        # Both branches now hold the source's state as it was merged: that is
        # their last common state for the next merge. Written without touching
        # the source's version, since its design did not change.
        merged_from = gz(source.data)
        if kind == "from-parent":
            Branch.objects.filter(pk=target.pk).update(base_gz=merged_from)
        else:
            # Its changes now live on in the parent: the branch is done
            Branch.objects.filter(pk=source.pk).update(base_gz=merged_from, closed_at=timezone.now())
        BranchMerge.objects.create(
            project=project, source=source, target=target, source_name=source.name, target_name=target.name,
        )
        project.active_branch = target
        project.save(update_fields=["active_branch", "updated_at"])
    target.refresh_from_db()
    return Response(_detail_json(project, target))


# ── The user's part library ─────────────────────────────


def _owned_branches(user):
    """Every open branch of every project the user owns: a library part can be
    in any. Merged branches are history and stay as they were."""
    return Branch.objects.filter(project__owner=user, closed_at__isnull=True).select_related("project")


def _part_json(p):
    return {"id": str(p.id), "part": p.part, "rev": p.rev, "updated_at": p.updated_at}


@cache_control(private=True, no_store=True)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def user_parts(request):
    parts = UserPart.objects.filter(owner=request.user)
    if request.method == "GET":
        out = [_part_json(p) for p in parts]
        # With ?usage=1 each part says how many projects hold a linked copy.
        # It reads every project of the user, so only the parts page asks.
        if request.query_params.get("usage"):
            used = {}
            for branch in _owned_branches(request.user):
                for d in branch.data.get("componentDefs") or [] if isinstance(branch.data, dict) else []:
                    lib = d.get("library") if isinstance(d, dict) else None
                    if isinstance(lib, dict):
                        used.setdefault(lib.get("id"), set()).add(branch.project_id)
            for row in out:
                row["used_in"] = len(used.get(row["id"], ()))
        return Response(out)

    part = request.data.get("part")
    error = validate_part(part)
    if error:
        return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
    if parts.count() >= MAX_PARTS_PER_USER:
        return _library_full()
    created = UserPart.objects.create(owner=request.user, part=stored_part(part))
    return Response(_part_json(created), status=status.HTTP_201_CREATED)


def _library_full():
    return Response(
        {"error": f"Your library is full ({MAX_PARTS_PER_USER} parts). Delete a part to make room.", "code": "library_full"},
        status=status.HTTP_403_FORBIDDEN,
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def user_parts_import(request):
    """Adds every part of an exported parts file as a new library part."""
    parts = request.data.get("parts")
    if not isinstance(parts, list) or not parts:
        return Response({"error": "The file holds no parts"}, status=status.HTTP_400_BAD_REQUEST)
    for i, part in enumerate(parts):
        error = validate_part(part)
        if error:
            return Response({"error": f"Part {i + 1}: {error}"}, status=status.HTTP_400_BAD_REQUEST)
    if UserPart.objects.filter(owner=request.user).count() + len(parts) > MAX_PARTS_PER_USER:
        return _library_full()
    created = UserPart.objects.bulk_create([UserPart(owner=request.user, part=stored_part(p)) for p in parts])
    return Response([_part_json(p) for p in created], status=status.HTTP_201_CREATED)


@cache_control(private=True, no_store=True)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_parts_found(request):
    """Custom parts that so far live only inside the user's projects."""
    library_ids = {str(i) for i in UserPart.objects.filter(owner=request.user).values_list("id", flat=True)}
    designs = [(b.project, b.data) for b in _owned_branches(request.user)]
    return Response(found_in_projects(designs, library_ids))


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def user_parts_adopt(request):
    """
    Makes a part found in the user's projects a library part and links every
    identical copy in those projects to it. The part comes from the projects
    themselves, named by its key, never from the request.
    """
    key = request.data.get("key")
    library_ids = {str(i) for i in UserPart.objects.filter(owner=request.user).values_list("id", flat=True)}
    with transaction.atomic():
        branches = list(_owned_branches(request.user).select_for_update())
        designs = [(b.project, b.data) for b in branches]
        group = next((g for g in found_in_projects(designs, library_ids) if g["key"] == key), None)
        if group is None:
            return Response({"error": "Part not found in your projects"}, status=status.HTTP_404_NOT_FOUND)
        if len(library_ids) >= MAX_PARTS_PER_USER:
            return _library_full()
        created = UserPart.objects.create(owner=request.user, part=group["part"])
        linked = set()
        for branch in branches:
            if link_copies(branch.data, key, str(created.id), library_ids):
                branch.save(update_fields=["data", "updated_at"])
                linked.add(branch.project_id)
    return Response({**_part_json(created), "linked_projects": len(linked)}, status=status.HTTP_201_CREATED)


@api_view(["PUT", "DELETE"])
@permission_classes([IsAuthenticated])
def user_part_detail(request, part_id):
    try:
        user_part = UserPart.objects.get(id=part_id, owner=request.user)
    except UserPart.DoesNotExist:
        return Response({"error": "Part not found"}, status=status.HTTP_404_NOT_FOUND)

    if request.method == "DELETE":
        # Copies in projects stay as they are; their link just leads nowhere now
        user_part.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    part = request.data.get("part")
    error = validate_part(part)
    if error:
        return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
    part = stored_part(part)
    # The branch being edited applies the change itself and saves it; writing
    # it here as well would race that save. An editor from before branches
    # names only its project, and it was editing the main branch.
    skip_branch = str(request.data.get("skip_branch") or "")
    skip_project = str(request.data.get("skip_project") or "")
    updated = set()
    with transaction.atomic():
        user_part.part = part
        user_part.rev += 1
        user_part.save()
        if request.data.get("update_projects"):
            for branch in _owned_branches(request.user).select_for_update():
                if str(branch.id) == skip_branch or (
                    not skip_branch and str(branch.project.edit_uuid) == skip_project
                    and branch.id == branch.project.main_branch_id
                ):
                    continue
                if apply_to_project(branch.data, str(user_part.id), part, user_part.rev):
                    branch.save(update_fields=["data", "updated_at"])
                    updated.add(branch.project_id)
    return Response({**_part_json(user_part), "updated_projects": len(updated)})


@cache_control(private=True, no_store=True)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_part_usage(request, part_id):
    """The owner's projects holding a linked copy, and how many of those are placed."""
    if not UserPart.objects.filter(id=part_id, owner=request.user).exists():
        return Response({"error": "Part not found"}, status=status.HTTP_404_NOT_FOUND)
    # One entry per project; a part placed on several branches counts by the
    # branch where it is placed most
    out = {}
    for branch in _owned_branches(request.user):
        copies = linked_copies(branch.data, str(part_id))
        if copies:
            entry = out.setdefault(branch.project_id, {
                "edit_uuid": str(branch.project.edit_uuid), "name": branch.project.name, "placed": 0,
            })
            entry["placed"] = max(entry["placed"], placed_count(branch.data, {d.get("id") for d in copies}))
    return Response(list(out.values()))


# ── The user's own boards ───────────────────────────────


def _board_json(b):
    return {"id": str(b.id), "board": b.board, "rev": b.rev, "updated_at": b.updated_at}


def _boards_full():
    return Response(
        {
            "error": f"Your library is full ({user_boards.MAX_BOARDS_PER_USER} boards). Delete a board to make room.",
            "code": "library_full",
        },
        status=status.HTTP_403_FORBIDDEN,
    )


@cache_control(private=True, no_store=True)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def user_boards_list(request):
    boards = UserBoard.objects.filter(owner=request.user)
    if request.method == "GET":
        out = [_board_json(b) for b in boards]
        # With ?usage=1 each board says how many projects are on a linked
        # copy. It reads every project of the user, so only the boards page asks.
        if request.query_params.get("usage"):
            used = {}
            for branch in _owned_branches(request.user):
                for row in out:
                    if user_boards.is_linked(branch.data, row["id"]):
                        used.setdefault(row["id"], set()).add(branch.project_id)
            for row in out:
                row["used_in"] = len(used.get(row["id"], ()))
        return Response(out)

    board = request.data.get("board")
    error = user_boards.validate_board(board)
    if error:
        return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
    if boards.count() >= user_boards.MAX_BOARDS_PER_USER:
        return _boards_full()
    created = UserBoard.objects.create(owner=request.user, board=user_boards.stored_board(board))
    return Response(_board_json(created), status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def user_boards_import(request):
    """Adds every board of an exported boards file as a new library board."""
    boards = request.data.get("boards")
    if not isinstance(boards, list) or not boards:
        return Response({"error": "The file holds no boards"}, status=status.HTTP_400_BAD_REQUEST)
    for i, board in enumerate(boards):
        error = user_boards.validate_board(board)
        if error:
            return Response({"error": f"Board {i + 1}: {error}"}, status=status.HTTP_400_BAD_REQUEST)
    if UserBoard.objects.filter(owner=request.user).count() + len(boards) > user_boards.MAX_BOARDS_PER_USER:
        return _boards_full()
    created = UserBoard.objects.bulk_create(
        [UserBoard(owner=request.user, board=user_boards.stored_board(b)) for b in boards]
    )
    return Response([_board_json(b) for b in created], status=status.HTTP_201_CREATED)


@api_view(["PUT", "DELETE"])
@permission_classes([IsAuthenticated])
def user_board_detail(request, board_id):
    try:
        user_board = UserBoard.objects.get(id=board_id, owner=request.user)
    except UserBoard.DoesNotExist:
        return Response({"error": "Board not found"}, status=status.HTTP_404_NOT_FOUND)

    if request.method == "DELETE":
        # Projects keep their copy; its link just leads nowhere now
        user_board.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    board = request.data.get("board")
    error = user_boards.validate_board(board)
    if error:
        return Response({"error": error}, status=status.HTTP_400_BAD_REQUEST)
    board = user_boards.stored_board(board)
    # The branch open in the editor puts the change on itself and saves it,
    # as for parts (user_part_detail)
    skip_branch = str(request.data.get("skip_branch") or "")
    updated = set()
    with transaction.atomic():
        user_board.board = board
        user_board.rev += 1
        user_board.save()
        if request.data.get("update_projects"):
            for branch in _owned_branches(request.user).select_for_update():
                if str(branch.id) == skip_branch:
                    continue
                if user_boards.apply_to_project(branch.data, str(user_board.id), board, user_board.rev):
                    branch.save(update_fields=["data", "updated_at"])
                    updated.add(branch.project_id)
    return Response({**_board_json(user_board), "updated_projects": len(updated)})


@cache_control(private=True, no_store=True)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_board_usage(request, board_id):
    """The owner's projects on a linked copy of the board, and how many parts
    are placed on it (by the branch with the most)."""
    if not UserBoard.objects.filter(id=board_id, owner=request.user).exists():
        return Response({"error": "Board not found"}, status=status.HTTP_404_NOT_FOUND)
    out = {}
    for branch in _owned_branches(request.user):
        if user_boards.is_linked(branch.data, str(board_id)):
            entry = out.setdefault(branch.project_id, {
                "edit_uuid": str(branch.project.edit_uuid), "name": branch.project.name, "placed": 0,
            })
            entry["placed"] = max(entry["placed"], user_boards.placed_count(branch.data))
    return Response(list(out.values()))


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


# ── Layout ratings ──────────────────────────────────────

@api_view(["POST"])
@throttle_classes([LayoutRatingThrottle, LayoutRatingUserThrottle])
def layout_rating_create(request):
    serializer = LayoutRatingCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    project = None
    edit_uuid = data.get("project_edit_uuid")
    if edit_uuid:
        project = Project.objects.filter(edit_uuid=edit_uuid).first()

    snapshot_gz = gzip.compress(json.dumps(data["snapshot"]).encode("utf-8"))

    LayoutRating.objects.create(
        rating=data["rating"],
        snapshot_gz=snapshot_gz,
        metrics=data.get("metrics") or {},
        solver_version=data.get("solver_version", ""),
        user=request.user if request.user.is_authenticated else None,
        project=project,
        project_edit_uuid=edit_uuid,
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
