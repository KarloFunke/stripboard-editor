from django import forms
from django.contrib import admin
from django.db.models import F, Max, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.html import format_html
from .models import Project, PowChallenge, Feedback, FeedbackReply, LayoutRating


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["name", "owner", "view_link", "created_at", "updated_at"]
    list_filter = ["owner", "created_at"]
    search_fields = ["name", "edit_uuid", "view_uuid"]
    readonly_fields = ["edit_uuid", "view_uuid", "view_link", "created_at", "updated_at"]
    raw_id_fields = ["owner", "fork_of"]

    @admin.display(description="View")
    def view_link(self, obj):
        url = f"https://stripboard-editor.com/view/{obj.view_uuid}"
        return format_html('<a href="{}" target="_blank">Open</a>', url)


@admin.register(LayoutRating)
class LayoutRatingAdmin(admin.ModelAdmin):
    list_display = ["rating", "solver_version", "metrics_summary", "project_edit_uuid", "user", "created_at"]
    list_filter = ["rating", "solver_version", "created_at"]
    readonly_fields = ["rating", "solver_version", "metrics", "snapshot_size", "user", "project", "project_edit_uuid", "created_at"]
    exclude = ["snapshot_gz"]
    raw_id_fields = ["user", "project"]

    @admin.display(description="Metrics")
    def metrics_summary(self, obj):
        m = obj.metrics or {}
        rows, cols = m.get("rows"), m.get("cols")
        parts = m.get("parts")
        if rows is None and cols is None:
            return "-"
        return f"{rows}x{cols}, {parts} parts, q{m.get('quality')}"

    @admin.display(description="Snapshot (gzipped bytes)")
    def snapshot_size(self, obj):
        return len(obj.snapshot_gz) if obj.snapshot_gz else 0


@admin.register(PowChallenge)
class PowChallengeAdmin(admin.ModelAdmin):
    list_display = ["challenge", "expires_at", "created_at"]
    readonly_fields = ["challenge", "expires_at", "created_at"]


class FeedbackReplyInlineForm(forms.ModelForm):
    class Meta:
        model = FeedbackReply
        fields = ["from_staff", "body"]
        widgets = {
            "body": forms.Textarea(attrs={"rows": 3, "cols": 50}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk:
            # Stored replies (and the original question) stay read-only.
            for field in self.fields.values():
                field.disabled = True
        else:
            # A new reply is always from me, append-only.
            self.fields["from_staff"].initial = True
            self.fields["from_staff"].disabled = True


class FeedbackReplyInline(admin.TabularInline):
    model = FeedbackReply
    form = FeedbackReplyInlineForm
    extra = 1
    can_delete = False
    fields = ["from_staff", "body", "created_at"]
    readonly_fields = ["created_at"]


@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ["short_message", "unseen", "user", "contact", "reply_count", "last_activity"]
    list_filter = ["created_at"]
    search_fields = ["message", "contact"]
    readonly_fields = ["message", "contact", "user", "created_at", "user_last_seen", "staff_last_seen"]
    inlines = [FeedbackReplyInline]

    def get_ordering(self, request):
        # Default to most-recent-activity first (annotation set in get_queryset).
        return ["-last_activity"]

    def get_queryset(self, request):
        # Annotate before ordering so get_ordering can sort by last_activity.
        # last_activity: newest message in the thread (a reply, or the opening
        # message if there are none). last_user_msg: newest message from the
        # user only (the opening message is always theirs), used for the "New" flag.
        qs = self.model._default_manager.get_queryset().annotate(
            last_activity=Coalesce(Max("replies__created_at"), F("created_at")),
            last_user_msg=Coalesce(
                Max("replies__created_at", filter=Q(replies__from_staff=False)),
                F("created_at"),
            ),
        )
        ordering = self.get_ordering(request)
        return qs.order_by(*ordering) if ordering else qs

    def change_view(self, request, object_id, form_url="", extra_context=None):
        # Opening a thread marks its user messages seen.
        Feedback.objects.filter(pk=object_id).update(staff_last_seen=timezone.now())
        return super().change_view(request, object_id, form_url, extra_context)

    @admin.display(description="Message")
    def short_message(self, obj):
        return obj.message[:60]

    @admin.display(description="Replies")
    def reply_count(self, obj):
        return obj.replies.count()

    @admin.display(description="Last activity", ordering="last_activity")
    def last_activity(self, obj):
        return obj.last_activity

    @admin.display(description="New", boolean=True)
    def unseen(self, obj):
        return obj.staff_last_seen is None or obj.last_user_msg > obj.staff_last_seen
