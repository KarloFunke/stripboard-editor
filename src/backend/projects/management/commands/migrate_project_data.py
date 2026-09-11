"""
Bring every stored project up to the current schema (migrations_data.pipeline).
Idempotent, so it runs on every container start: a deploy leaves no window in
which the frontend is newer than the rows it reads.

Run:  python manage.py migrate_project_data --dry-run
      python manage.py migrate_project_data
      python manage.py migrate_project_data --report /tmp/migration.csv

A row already on v3 that lacks the wiring decision (migrated by an earlier
build) gets it filled in; a decision that is present is never changed.
"""

import csv

from django.core.management.base import BaseCommand

from projects.migrations_data.pipeline import migrate_to_current
from projects.models import Project


class Command(BaseCommand):
    help = "Migrate stored project data to the current schema."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Show changes without saving")
        parser.add_argument("--limit", type=int, default=None, help="Process only the first N rows")
        parser.add_argument("--project", type=str, default=None, help="Process a single edit_uuid")
        parser.add_argument("--report", type=str, default=None, help="Write CSV report to this path")

    def handle(self, *args, **opts):
        qs = Project.objects.all().order_by("created_at")
        if opts["project"]:
            qs = qs.filter(edit_uuid=opts["project"])
        if opts["limit"]:
            qs = qs[: opts["limit"]]

        migrated = 0
        skipped = 0
        failed = 0
        report_rows = []

        for project in qs:
            try:
                before = len((project.data or {}).get("schematicWires") or [])
                data, changed = migrate_to_current(project.data)
                after = len(data.get("schematicWires") or []) if isinstance(data, dict) else before
                if not changed:
                    skipped += 1
                    report_rows.append((project.edit_uuid, project.owner_id, project.name, False, before, after))
                    continue
                if opts["dry_run"]:
                    self.stdout.write(f"  [{project.pk}] would migrate: {project.name} ({before} -> {after} wires)")
                else:
                    project.data = data
                    project.save(update_fields=["data"])
                migrated += 1
                report_rows.append((project.edit_uuid, project.owner_id, project.name, True, before, after))
            except Exception as e:
                failed += 1
                self.stdout.write(self.style.ERROR(f"  [{project.pk}] FAILED: {e}"))

        if opts["report"]:
            with open(opts["report"], "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["edit_uuid", "owner_id", "name", "changed", "wires_before", "wires_after"])
                writer.writerows(report_rows)

        verb = "Would migrate" if opts["dry_run"] else "Migrated"
        self.stdout.write(self.style.SUCCESS(
            f"\n{verb} {migrated}, skipped {skipped}, failed {failed}"
        ))
