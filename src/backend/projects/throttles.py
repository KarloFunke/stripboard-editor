from rest_framework.throttling import AnonRateThrottle


class ProjectCreateThrottle(AnonRateThrottle):
    scope = "project_create"


class AuthThrottle(AnonRateThrottle):
    scope = "auth"


class PowChallengeThrottle(AnonRateThrottle):
    scope = "pow_challenge"
