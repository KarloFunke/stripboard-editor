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


# Same scope/rate as FeedbackThrottle but keyed per-user, so authenticated
# submissions are throttled too (AnonRateThrottle ignores logged-in users).
class FeedbackUserThrottle(UserRateThrottle):
    scope = "feedback"
