from django.contrib import admin
from .models import Project, PowChallenge


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["name", "owner", "edit_uuid", "created_at", "updated_at"]
    list_filter = ["owner", "created_at"]
    search_fields = ["name", "edit_uuid", "view_uuid"]
    readonly_fields = ["edit_uuid", "view_uuid", "created_at", "updated_at"]
    raw_id_fields = ["owner", "fork_of"]


@admin.register(PowChallenge)
class PowChallengeAdmin(admin.ModelAdmin):
    list_display = ["challenge", "expires_at", "created_at"]
    readonly_fields = ["challenge", "expires_at", "created_at"]
