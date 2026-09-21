"""
All project-data migrations, oldest first. Every step is idempotent and
guards on the version it produces, so running the pipeline on data of any
age brings it to the current schema in one pass.
"""

from .ic_unification import migrate_ic_unification
from .optocoupler_v4 import SCHEMA_VERSION, migrate_optocoupler_v4
from .schematic_v3 import migrate_schematic_v3

CURRENT_SCHEMA_VERSION = SCHEMA_VERSION

_STEPS = (migrate_ic_unification, migrate_schematic_v3, migrate_optocoupler_v4)


def migrate_to_current(data):
    """Returns (data, changed). Never raises on malformed input."""
    changed = False
    for step in _STEPS:
        data, step_changed = step(data)
        changed = changed or step_changed
    return data, changed
