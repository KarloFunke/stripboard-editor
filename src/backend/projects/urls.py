from django.urls import path
from . import views

urlpatterns = [
    # Projects
    path("projects/", views.project_create, name="project-create"),
    path("projects/<uuid:edit_uuid>/", views.project_detail, name="project-detail"),
    path("projects/<uuid:edit_uuid>/claim/", views.project_claim, name="project-claim"),
    path("projects/view/<uuid:view_uuid>/", views.project_view, name="project-view"),
    path("projects/fork/<uuid:view_uuid>/", views.project_fork, name="project-fork"),
    path("users/me/projects/", views.user_projects, name="user-projects"),

    # Auth
    path("auth/register/", views.auth_register, name="auth-register"),
    path("auth/login/", views.auth_login, name="auth-login"),
    path("auth/logout/", views.auth_logout, name="auth-logout"),
    path("auth/me/", views.auth_me, name="auth-me"),
    path("auth/csrf/", views.csrf_token, name="csrf-token"),

    # Proof of Work
    path("pow/challenge/", views.pow_challenge, name="pow-challenge"),
]
