"""
Migrate project schematic data v1 → v2: snap wire endpoints from old IC pin
positions (generic-ic-N ±50, 555/optocoupler ±40) to the unified new positions (±60).
Idempotent. Run after deploying v2 backend + frontend.

Run:  python manage.py migrate_ic_unification --dry-run
      python manage.py migrate_ic_unification
      python manage.py migrate_ic_unification --report /tmp/ic_migration.csv
"""

import csv

from django.core.management.base import BaseCommand

from projects.migrations_data.ic_unification import migrate_ic_unification
from projects.models import Project


class Command(BaseCommand):
    help = "Migrate project data from v1 to v2 (IC pin unification)."

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
                data, changed = migrate_ic_unification(project.data)
                if not changed:
                    skipped += 1
                    report_rows.append((project.edit_uuid, project.owner_id, project.name, False))
                    continue
                if opts["dry_run"]:
                    self.stdout.write(f"  [{project.edit_uuid}] would migrate: {project.name}")
                else:
                    project.data = data
                    project.save(update_fields=["data"])
                migrated += 1
                report_rows.append((project.edit_uuid, project.owner_id, project.name, True))
            except Exception as e:
                failed += 1
                self.stdout.write(self.style.ERROR(f"  [{project.edit_uuid}] FAILED: {e}"))

        if opts["report"]:
            with open(opts["report"], "w", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(["edit_uuid", "owner_id", "name", "changed"])
                writer.writerows(report_rows)

        verb = "Would migrate" if opts["dry_run"] else "Migrated"
        self.stdout.write(self.style.SUCCESS(
            f"\n{verb} {migrated}, skipped {skipped}, failed {failed}"
        ))
