"""
Migrate project data from v1 (tag-based, manual nets) to v2 (symbol-based, wire-based nets).

Changes per project:
1. Map component tags to symbol IDs
2. Add schematicRotation: 0 to all components
3. Remove 'tag' field from components
4. Auto-generate schematicWires from netAssignments (MST-based)
5. Remove customTags
6. Add symbol + defaultLabelPrefix to custom ComponentDefs

Run: python manage.py migrate_schematic_v2
"""

import json
import math
import uuid
from django.core.management.base import BaseCommand
from projects.models import Project


# Tag -> (symbol, prefix) mapping
TAG_SYMBOL_MAP = {
    "Resistor": ("resistor", "R"),
    "Capacitor": ("capacitor", "C"),
    "Diode": ("diode", "D"),
    "LED": ("led", "D"),
    "IC": ("generic-ic", "U"),
    "Connector": ("connector", "J"),
    "Regulator": ("vreg", "U"),
    "Relay": ("generic-ic", "U"),
    "Crystal": ("generic-2pin", "X"),
}


def infer_symbol_from_def_id(def_id, tag):
    """Determine symbol and prefix from tag and defId."""
    # First check tag
    if tag and tag in TAG_SYMBOL_MAP:
        return TAG_SYMBOL_MAP[tag]

    # Infer from defId pattern
    if not def_id:
        return ("generic-2pin", "X")

    if def_id.startswith("def-dip") or def_id.startswith("def-ic-dip"):
        return ("generic-ic", "U")
    if def_id.startswith("def-inline-") or def_id.startswith("def-connector-"):
        return ("connector", "J")
    if def_id.startswith("def-3pin-") or def_id.startswith("def-generic-3pin"):
        return ("generic-3pin", "X")
    if def_id.startswith("def-2pin-") or def_id.startswith("def-generic-2pin"):
        return ("generic-2pin", "X")

    return ("generic-2pin", "X")


def compute_mst_wires(net_pins, components):
    """
    Given a list of (componentId, pinId) pairs for a net,
    compute MST edges using Prim's algorithm over schematic positions.
    Returns list of (from_endpoint, to_endpoint) pairs.
    """
    if len(net_pins) < 2:
        return []

    # Get positions for each pin (approximate: use component schematicPos)
    positions = []
    for comp_id, pin_id in net_pins:
        comp = next((c for c in components if c.get("id") == comp_id), None)
        if comp and comp.get("schematicPos"):
            pos = comp["schematicPos"]
            positions.append({
                "componentId": comp_id,
                "pinId": pin_id,
                "x": pos.get("x", 0),
                "y": pos.get("y", 0),
            })

    if len(positions) < 2:
        return []

    # Prim's MST
    n = len(positions)
    in_mst = [False] * n
    min_dist = [float("inf")] * n
    parent = [-1] * n
    min_dist[0] = 0

    edges = []
    for _ in range(n):
        # Find closest non-MST node
        u = -1
        for v in range(n):
            if not in_mst[v] and (u == -1 or min_dist[v] < min_dist[u]):
                u = v
        if u == -1:
            break

        in_mst[u] = True
        if parent[u] != -1:
            edges.append((parent[u], u))

        # Update distances
        for v in range(n):
            if not in_mst[v]:
                dx = positions[u]["x"] - positions[v]["x"]
                dy = positions[u]["y"] - positions[v]["y"]
                dist = math.sqrt(dx * dx + dy * dy)
                if dist < min_dist[v]:
                    min_dist[v] = dist
                    parent[v] = u

    # Convert to L-routed wires
    wires = []
    for u, v in edges:
        dx = abs(positions[v]["x"] - positions[u]["x"])
        dy = abs(positions[v]["y"] - positions[u]["y"])
        wires.append({
            "id": str(uuid.uuid4()),
            "start": {
                "x": positions[u]["x"],
                "y": positions[u]["y"],
            },
            "end": {
                "x": positions[v]["x"],
                "y": positions[v]["y"],
            },
            "routeDirection": "horizontal-first" if dx >= dy else "vertical-first",
        })

    return wires


class Command(BaseCommand):
    help = "Migrate project data from v1 (tags) to v2 (symbols + wires)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would change without saving",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        projects = Project.objects.all()
        total = projects.count()
        migrated = 0
        skipped = 0

        self.stdout.write(f"Found {total} projects to migrate")

        for project in projects:
            data = project.data
            if not data or not isinstance(data, dict):
                skipped += 1
                continue

            # Skip already migrated projects (have schematicWires)
            if "schematicWires" in data and data["schematicWires"]:
                skipped += 1
                continue

            components = data.get("components", [])
            net_assignments = data.get("netAssignments", [])
            component_defs = data.get("componentDefs", [])

            # 1. Migrate components: add schematicRotation, remove tag
            for comp in components:
                tag = comp.pop("tag", "")
                comp["schematicRotation"] = 0

            # 2. Migrate custom component defs: add symbol + defaultLabelPrefix
            for cdef in component_defs:
                if "symbol" not in cdef:
                    tag_hint = ""  # No tag on defs, infer from id
                    symbol, prefix = infer_symbol_from_def_id(cdef.get("id", ""), tag_hint)
                    cdef["symbol"] = symbol
                    cdef["defaultLabelPrefix"] = prefix

            # 3. Generate schematic wires from net assignments (MST)
            # Group assignments by net
            nets_pins = {}
            for assignment in net_assignments:
                net_id = assignment.get("netId")
                comp_id = assignment.get("componentId")
                pin_id = assignment.get("pinId")
                if net_id and comp_id and pin_id:
                    if net_id not in nets_pins:
                        nets_pins[net_id] = []
                    nets_pins[net_id].append((comp_id, pin_id))

            schematic_wires = []
            for net_id, pins in nets_pins.items():
                wires = compute_mst_wires(pins, components)
                schematic_wires.extend(wires)

            data["schematicWires"] = schematic_wires

            # 4. Remove customTags
            data.pop("customTags", None)

            if dry_run:
                wire_count = len(schematic_wires)
                self.stdout.write(
                    f"  [{project.edit_uuid}] {project.name}: "
                    f"{len(components)} components, {wire_count} wires generated"
                )
            else:
                project.data = data
                project.save(update_fields=["data"])

            migrated += 1

        action = "Would migrate" if dry_run else "Migrated"
        self.stdout.write(
            self.style.SUCCESS(
                f"\n{action} {migrated} projects, skipped {skipped}"
            )
        )
