"""
Migrate project data from v1 (tag-based, manual nets) to v2 (symbol-based, wire-based nets).

Changes per project:
1. Map component defIds from old footprint-based IDs to new component-type IDs (based on tag)
2. Add schematicRotation: 0, remove 'tag' field
3. Initialize flexibleEndPos for flexible 2-pin components placed on the board
4. Auto-generate schematicWires from netAssignments with correct pin positions
5. Remove customTags, footprintOverride on flexible components
6. Add symbol + defaultLabelPrefix to custom ComponentDefs
7. Snap schematic positions to grid (multiples of 20)

Run: python manage.py migrate_schematic_v2
"""

import math
import uuid
from django.core.management.base import BaseCommand
from projects.models import Project

G = 20  # grid size

# Old defId + tag -> new defId mapping
TAG_DEF_MAP = {
    "Resistor": "def-resistor",
    "Capacitor": "def-capacitor",
    "Diode": "def-diode",
    "LED": "def-led",
    "Connector": None,
    "Regulator": "def-vreg",
    "IC": None,
    "Relay": None,
    "Crystal": None,
}

# Old footprint pin2 offsets (row, col) for computing flexibleEndPos
OLD_PIN2_OFFSETS = {
    "def-2pin-2h": (1, 0),
    "def-2pin-3h": (2, 0),
    "def-2pin-4h": (3, 0),
    "def-2pin-5h": (4, 0),
    "def-2pin-7h": (6, 0),
    "def-generic-2pin-2h": (1, 0),
    "def-generic-2pin-3h": (2, 0),
    "def-generic-2pin-4h": (3, 0),
    "def-generic-2pin-5h": (4, 0),
    "def-generic-2pin-7h": (6, 0),
}

# New flexible component def -> pin2 offset (for when old def not found)
FLEXIBLE_DEFS = {
    "def-resistor", "def-capacitor", "def-cap-polarized",
    "def-diode", "def-led", "def-zener", "def-inductor",
}

# Hardcoded schematic pin stub positions (x, y) relative to component center
# for each new defId. These match symbolDefs.ts exactly.
# Only schematicRotation=0, no mirroring (old system didn't support these)
DIODE_LEAD = 2 * G  # 40

PIN_POSITIONS = {
    # Passive 2-pin vertical: pins at (0, -G) and (0, G)
    "def-resistor": {"1": (0, -G), "2": (0, G)},
    "def-capacitor": {"1": (0, -G), "2": (0, G)},
    "def-cap-polarized": {"1": (0, -G), "2": (0, G)},
    "def-inductor": {"1": (0, -G), "2": (0, G)},
    # Passive 2-pin horizontal: pins at (-DIODE_LEAD, 0) and (DIODE_LEAD, 0)
    "def-diode": {"1": (-DIODE_LEAD, 0), "2": (DIODE_LEAD, 0)},
    "def-led": {"1": (-DIODE_LEAD, 0), "2": (DIODE_LEAD, 0)},
    "def-zener": {"1": (-DIODE_LEAD, 0), "2": (DIODE_LEAD, 0)},
    # Switch
    "def-switch": {"1": (-G, 0), "2": (2 * G, 0)},
    # Semiconductors: B at (-2G, 0), C at (G, -2G), E at (G, 2G)
    "def-npn": {"1": (-2 * G, 0), "2": (G, -2 * G), "3": (G, 2 * G)},
    "def-pnp": {"1": (-2 * G, 0), "2": (G, -2 * G), "3": (G, 2 * G)},
    "def-nmos": {"1": (-2 * G, 0), "2": (G, -2 * G), "3": (G, 2 * G)},
    "def-pmos": {"1": (-2 * G, 0), "2": (G, -2 * G), "3": (G, 2 * G)},
    # Voltage regulator: IN at (-2G, 0), OUT at (2G, 0), GND at (0, 2G)
    "def-vreg": {"1": (-2 * G, 0), "2": (2 * G, 0), "3": (0, 2 * G)},
    # 555 Timer
    "def-555": {
        "1": (-2 * G, -G), "2": (-2 * G, 0), "3": (-2 * G, G), "4": (-2 * G, 2 * G),
        "5": (2 * G, 2 * G), "6": (2 * G, G), "7": (2 * G, 0), "8": (2 * G, -G),
    },
    # Optocoupler
    "def-optocoupler": {
        "1": (-2 * G, -G), "2": (-2 * G, G),
        "3": (2 * G, -G), "4": (2 * G, G),
    },
    # Op-Amp (pin IDs match LM741 DIP pinout)
    "def-opamp": {
        "3": (-2 * G, -G), "2": (-2 * G, G),
        "6": (2 * G, 0),
        "7": (0, -2 * G), "4": (0, 2 * G),
    },
}


def snap(val):
    return round(val / G) * G


def rotate_offset(r, c, rotation, max_row, max_col):
    if rotation == 90:
        return (c, max_row - r)
    elif rotation == 180:
        return (max_row - r, max_col - c)
    elif rotation == 270:
        return (max_col - c, r)
    return (r, c)


def map_def_id(old_def_id, tag):
    if tag in TAG_DEF_MAP and TAG_DEF_MAP[tag]:
        return TAG_DEF_MAP[tag]

    if tag == "Connector":
        if "2pin" in old_def_id or "2h" in old_def_id:
            return "def-connector-2"
        if "3pin" in old_def_id or "3h" in old_def_id:
            return "def-connector-3"
        if old_def_id.startswith("def-inline-"):
            try:
                return f"def-connector-{int(old_def_id.split('-')[-1])}"
            except ValueError:
                pass
        return "def-connector-2"

    if tag in ("IC", "Relay"):
        for prefix in ("def-dip", "def-generic-dip"):
            if old_def_id.startswith(prefix):
                try:
                    n = int(old_def_id[len(prefix):])
                    return f"def-ic-dip{n}"
                except ValueError:
                    pass
        return old_def_id

    # No tag — infer from defId
    if not tag:
        if "dip" in old_def_id:
            for prefix in ("def-dip", "def-generic-dip"):
                if old_def_id.startswith(prefix):
                    try:
                        n = int(old_def_id[len(prefix):])
                        return f"def-ic-dip{n}"
                    except ValueError:
                        pass
        if "inline" in old_def_id:
            try:
                return f"def-connector-{int(old_def_id.split('-')[-1])}"
            except ValueError:
                pass
        if "3pin" in old_def_id:
            return "def-connector-3"
        if "2pin" in old_def_id or "2h" in old_def_id:
            return "def-connector-2"

    return old_def_id


def get_connector_pin_positions(pin_count):
    """Generate pin positions for connector-N symbols."""
    stub_end_x = -2 * G  # connectors have pins on the left
    extent = (pin_count - 1) * G
    y_start = -int(extent / 2 / G) * G
    positions = {}
    for i in range(pin_count):
        positions[str(i + 1)] = (stub_end_x, y_start + i * G)
    return positions


def get_generic_ic_pin_positions(pin_count):
    """Generate pin positions for generic-ic-N symbols (DIP layout)."""
    pins_per_side = (pin_count + 1) // 2
    right_count = pin_count - pins_per_side
    half_w = 30  # bodyWidth/2 = 60/2
    extent = (pins_per_side - 1) * G
    y_start = -int(extent / 2 / G) * G

    positions = {}
    for i in range(pins_per_side):
        y = y_start + i * G
        positions[str(i + 1)] = (-half_w - G, y)
    for i in range(right_count):
        y = y_start + extent - i * G
        positions[str(pins_per_side + i + 1)] = (half_w + G, y)
    return positions


def get_pin_position(def_id, pin_id):
    """Get the schematic pin position (x, y offset from component center) for a given def and pin."""
    # Check hardcoded positions first
    if def_id in PIN_POSITIONS:
        return PIN_POSITIONS[def_id].get(pin_id)

    # Dynamic connectors
    if def_id.startswith("def-connector-"):
        try:
            n = int(def_id.split("-")[-1])
            positions = get_connector_pin_positions(n)
            return positions.get(pin_id)
        except ValueError:
            pass

    # Dynamic ICs
    if def_id.startswith("def-ic-dip"):
        try:
            n = int(def_id.replace("def-ic-dip", ""))
            positions = get_generic_ic_pin_positions(n)
            return positions.get(pin_id)
        except ValueError:
            pass

    return None


def compute_flexible_pins(comp, old_def_id):
    """Compute pin1 and pin2 absolute board positions for a flexible component."""
    board_pos = comp.get("boardPos")
    if not board_pos:
        return None, None

    override = comp.get("footprintOverride")
    if override and override.get("pins"):
        pin1_off = pin2_off = None
        for p in override["pins"]:
            if p["id"] == "1":
                pin1_off = (p["offsetRow"], p["offsetCol"])
            elif p["id"] == "2":
                pin2_off = (p["offsetRow"], p["offsetCol"])
        pin1_off = pin1_off or (0, 0)
        pin2_off = pin2_off or OLD_PIN2_OFFSETS.get(old_def_id, (1, 0))
        max_row = max(pin1_off[0], pin2_off[0])
        max_col = max(pin1_off[1], pin2_off[1])
        if override.get("bodyCells"):
            for bc in override["bodyCells"]:
                max_row = max(max_row, bc["row"])
                max_col = max(max_col, bc["col"])
    else:
        pin1_off = (0, 0)
        pin2_off = OLD_PIN2_OFFSETS.get(old_def_id, (1, 0))
        max_row = pin2_off[0]
        max_col = max(pin1_off[1], pin2_off[1])

    rotation = comp.get("rotation", 0)
    p1 = rotate_offset(pin1_off[0], pin1_off[1], rotation, max_row, max_col)
    p2 = rotate_offset(pin2_off[0], pin2_off[1], rotation, max_row, max_col)

    return (
        {"row": board_pos["row"] + p1[0], "col": board_pos["col"] + p1[1]},
        {"row": board_pos["row"] + p2[0], "col": board_pos["col"] + p2[1]},
    )


def compute_mst_wires(pin_positions):
    """Compute MST wires over a list of (x, y) positions. Returns wire dicts."""
    if len(pin_positions) < 2:
        return []

    n = len(pin_positions)
    in_mst = [False] * n
    min_dist = [float("inf")] * n
    parent = [-1] * n
    min_dist[0] = 0
    edges = []

    for _ in range(n):
        u = -1
        for v in range(n):
            if not in_mst[v] and (u == -1 or min_dist[v] < min_dist[u]):
                u = v
        if u == -1:
            break
        in_mst[u] = True
        if parent[u] != -1:
            edges.append((parent[u], u))
        for v in range(n):
            if not in_mst[v]:
                dx = pin_positions[u][0] - pin_positions[v][0]
                dy = pin_positions[u][1] - pin_positions[v][1]
                d = math.sqrt(dx * dx + dy * dy)
                if d < min_dist[v]:
                    min_dist[v] = d
                    parent[v] = u

    wires = []
    for u, v in edges:
        sx, sy = pin_positions[u]
        ex, ey = pin_positions[v]
        dx = abs(ex - sx)
        dy = abs(ey - sy)
        wires.append({
            "id": str(uuid.uuid4()),
            "start": {"x": sx, "y": sy},
            "end": {"x": ex, "y": ey},
            "routeDirection": "horizontal-first" if dx >= dy else "vertical-first",
        })
    return wires


class Command(BaseCommand):
    help = "Migrate project data from v1 (tags) to v2 (symbols + wires)"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Show changes without saving")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        projects = Project.objects.all()
        total = projects.count()
        migrated = skipped = 0

        self.stdout.write(f"Found {total} projects to migrate")

        for project in projects:
            data = project.data
            if not data or not isinstance(data, dict):
                skipped += 1
                continue

            if "schematicWires" in data and data.get("schematicWires"):
                skipped += 1
                continue

            components = data.get("components", [])
            net_assignments = data.get("netAssignments", [])
            component_defs = data.get("componentDefs", [])

            # 1. Migrate components
            for comp in components:
                tag = comp.pop("tag", "")
                old_def_id = comp.get("defId", "")
                new_def_id = map_def_id(old_def_id, tag)
                comp["defId"] = new_def_id
                comp["schematicRotation"] = 0

                # Snap schematic positions to grid
                if comp.get("schematicPos"):
                    comp["schematicPos"]["x"] = snap(comp["schematicPos"]["x"])
                    comp["schematicPos"]["y"] = snap(comp["schematicPos"]["y"])

                # Flexible components: compute pin positions, remove override
                if new_def_id in FLEXIBLE_DEFS and comp.get("boardPos"):
                    pin1, pin2 = compute_flexible_pins(comp, old_def_id)
                    if pin1 and pin2:
                        comp["boardPos"] = pin1
                        comp["flexibleEndPos"] = pin2
                        comp["rotation"] = 0
                    comp.pop("footprintOverride", None)

            # 2. Migrate custom component defs
            for cdef in component_defs:
                if "symbol" not in cdef:
                    cdef_id = cdef.get("id", "")
                    pin_count = len(cdef.get("pins", []))
                    if "dip" in cdef_id:
                        cdef["symbol"] = f"generic-ic-{pin_count}" if pin_count else "generic-ic-4"
                        cdef["defaultLabelPrefix"] = "U"
                    elif "inline" in cdef_id or "connector" in cdef_id:
                        cdef["symbol"] = f"connector-{pin_count}" if pin_count else "connector-2"
                        cdef["defaultLabelPrefix"] = "J"
                    else:
                        cdef["symbol"] = "generic-2pin"
                        cdef["defaultLabelPrefix"] = "X"

            # 3. Generate schematic wires from net assignments with exact pin positions
            nets_pins = {}
            for a in net_assignments:
                net_id, comp_id, pin_id = a.get("netId"), a.get("componentId"), a.get("pinId")
                if net_id and comp_id and pin_id:
                    nets_pins.setdefault(net_id, []).append((comp_id, pin_id))

            schematic_wires = []
            for net_id, pins in nets_pins.items():
                # Resolve absolute pin positions on the schematic
                positions = []
                for comp_id, pin_id in pins:
                    comp = next((c for c in components if c.get("id") == comp_id), None)
                    if not comp or not comp.get("schematicPos"):
                        continue
                    pin_offset = get_pin_position(comp["defId"], pin_id)
                    if not pin_offset:
                        continue
                    positions.append((
                        comp["schematicPos"]["x"] + pin_offset[0],
                        comp["schematicPos"]["y"] + pin_offset[1],
                    ))

                wires = compute_mst_wires(positions)
                schematic_wires.extend(wires)

            data["schematicWires"] = schematic_wires

            # 4. Remove customTags
            data.pop("customTags", None)

            if dry_run:
                flex_count = sum(1 for c in components if c.get("flexibleEndPos"))
                self.stdout.write(
                    f"  [{project.edit_uuid}] {project.name}: "
                    f"{len(components)} components, {len(schematic_wires)} wires, "
                    f"{flex_count} flexible"
                )
            else:
                project.data = data
                project.save(update_fields=["data"])

            migrated += 1

        action = "Would migrate" if dry_run else "Migrated"
        self.stdout.write(self.style.SUCCESS(f"\n{action} {migrated} projects, skipped {skipped}"))
