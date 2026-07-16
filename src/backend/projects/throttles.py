from rest_framework.throttling import AnonRateThrottle, UserRateThrottle


class ProjectCreateThrottle(AnonRateThrottle):
    scope = "project_create"


class AuthThrottle(AnonRateThrottle):
    scope = "auth"


class PasswordResetThrottle(AnonRateThrottle):
    scope = "password_reset"


class PowChallengeThrottle(AnonRateThrottle):
    scope = "pow_challenge"


class FeedbackThrottle(AnonRateThrottle):
    scope = "feedback"


class LayoutRatingThrottle(AnonRateThrottle):
    scope = "layout_rating"


# Per-user counterpart so authenticated ratings are throttled too.
class LayoutRatingUserThrottle(UserRateThrottle):
    scope = "layout_rating"


# Same scope/rate as FeedbackThrottle but keyed per-user, so authenticated
# submissions are throttled too (AnonRateThrottle ignores logged-in users).
class FeedbackUserThrottle(UserRateThrottle):
    scope = "feedback"
