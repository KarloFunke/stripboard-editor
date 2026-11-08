import uuid
from django.db import models, transaction
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
    # Where the design lived before branches. create_main_branches moves it
    # into the project's main branch and clears it; to be dropped once every
    # deployment has run that.
    data = models.JSONField(null=True, blank=True)
    # The branch the view link shows; it is never deleted.
    main_branch = models.ForeignKey(
        "Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # The branch last saved or switched to: what the editor opens and the
    # project list previews.
    active_branch = models.ForeignKey(
        "Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
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

    @classmethod
    def create_with_main(cls, data, **fields):
        """A new project whose design is `data`, held by its main branch."""
        with transaction.atomic():
            project = cls.objects.create(**fields)
            main = Branch.objects.create(project=project, name="main", data=data)
            project.main_branch = project.active_branch = main
            project.save(update_fields=["main_branch", "active_branch"])
        return project


class Branch(models.Model):
    """One line of work in a project. Every branch holds its own copy of the
    design and is edited (and autosaved) on its own. A branch other than main
    starts from a parent branch and can take in the parent's changes or hand
    its own back; a fork's main branch has the original project's main as its
    parent, in the other project, and only takes in changes from it."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="branches")
    name = models.CharField(max_length=80)
    data = models.JSONField()
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children"
    )
    # The last state this branch and its parent had in common, gzipped JSON:
    # the base of a three-way merge between the two. Set when the branch
    # starts and after every merge between them.
    base_gz = models.BinaryField(null=True, blank=True)
    # Set when the branch was merged into its parent: it is done, kept only so
    # the history shows where the parent's changes came from
    closed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["project", "created_at"])]

    def __str__(self):
        return f"{self.name} ({self.project_id})"


class BranchMerge(models.Model):
    """One merge between a branch and its parent, kept to draw the history
    graph. The names are copied so a merge from a since deleted branch still
    reads right."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="merges")
    source = models.ForeignKey(Branch, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    target = models.ForeignKey(Branch, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    source_name = models.CharField(max_length=80)
    target_name = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def __str__(self):
        return f"{self.source_name} -> {self.target_name}"


class UserBoard(models.Model):
    """A board of the user's own: its name and copper (`{"name", "map"}`, the
    map as in boardPattern.ts). Like a UserPart, projects hold copies of it
    that carry `library: {"id", "rev"}`."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="boards")
    board = models.JSONField()
    rev = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["owner", "created_at"])]

    def __str__(self):
        name = self.board.get("name") if isinstance(self.board, dict) else None
        return f"{name or 'board'} ({self.owner_id})"


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


class UserPart(models.Model):
    """A custom part in a user's own library, usable in all of their projects.
    A project holds a copy of the part that remembers this id and the
    revision it was copied at (`library` on the copy), so a later edit can
    be carried into every project that still uses it unchanged."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="parts")
    # The part as the editor uses it (a ComponentDef)
    part = models.JSONField()
    rev = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["owner", "created_at"])]

    def __str__(self):
        name = self.part.get("name") if isinstance(self.part, dict) else None
        return f"{name or 'part'} ({self.owner_id})"
