from django.contrib import admin
from django.utils.html import format_html
from .models import Project, PowChallenge


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


@admin.register(PowChallenge)
class PowChallengeAdmin(admin.ModelAdmin):
    list_display = ["challenge", "expires_at", "created_at"]
    readonly_fields = ["challenge", "expires_at", "created_at"]
