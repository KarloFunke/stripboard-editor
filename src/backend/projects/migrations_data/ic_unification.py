"""
Schematic IC pin unification migration (v1 → v2).

The frontend unified the body geometry of generic-ic-N, timer-555, and
optocoupler symbols. Pin endpoint X-magnitudes changed:
    timer-555:    40 -> 60
    optocoupler:  40 -> 60
    generic-ic-N: 50 -> 60

Schematic wires are stored as absolute (x, y) endpoints. Any wire that
previously terminated at an old IC pin needs to be re-pointed at the new
pin position, otherwise net inference breaks.

`migrate_ic_unification(data)` is idempotent and never raises on malformed
input. Called from:
  - the management command (one-shot, all rows)
  - ProjectDetailSerializer.validate_data and ProjectCreateSerializer.validate_data
    (catches v1 frontend bundles still saving post-deploy)
  - project_fork (so a fork of a yet-unmigrated row produces v2 data)
"""

G = 20
SCHEMA_VERSION = 2

# Default defId → symbol. Custom defs use "custom-footprint-*" symbols, unaffected.
DEFAULT_IC_SYMBOLS = {
    "def-555": "timer-555",
    "def-optocoupler": "optocoupler",
    **{f"def-ic-dip{n}": f"generic-ic-{n}" for n in (4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40)},
}

_X_OLD = {"timer-555": 40, "optocoupler": 40, "generic-ic": 50}
_X_NEW = {"timer-555": 60, "optocoupler": 60, "generic-ic": 60}


def _apply_transform(x, y, rotation, mirrored):
    if mirrored:
        x = -x
    if rotation == 90:
        return (-y, x)
    if rotation == 180:
        return (-x, -y)
    if rotation == 270:
        return (y, -x)
    return (x, y)


def _timer_555_pins():
    ys = [-G, 0, G, 2 * G]
    return [(-1, y) for y in ys] + [(+1, y) for y in ys]


def _optocoupler_pins():
    ys = [-G, G]
    return [(-1, y) for y in ys] + [(+1, y) for y in ys]


def _generic_ic_pins(pin_count):
    """Mirrors createGenericIcSymbol's pin layout: left top→bottom, right bottom→top."""
    pins_per_side = (pin_count + 1) // 2  # Math.ceil
    right_count = pin_count - pins_per_side
    extent = (pins_per_side - 1) * G
    y_start = -(extent // (2 * G)) * G  # floor; matches Math.floor for non-negative extent
    left = [(-1, y_start + i * G) for i in range(pins_per_side)]
    right = [(+1, y_start + extent - i * G) for i in range(right_count)]
    return left + right


def _symbol_family(def_id):
    symbol = DEFAULT_IC_SYMBOLS.get(def_id, "")
    if symbol in ("timer-555", "optocoupler"):
        return symbol
    if symbol.startswith("generic-ic-"):
        return "generic-ic"
    return None


def _pin_offsets_for_def(def_id):
    """Returns list[(x_sign, y)] or None if defId isn't an affected IC."""
    symbol = DEFAULT_IC_SYMBOLS.get(def_id)
    if symbol == "timer-555":
        return _timer_555_pins()
    if symbol == "optocoupler":
        return _optocoupler_pins()
    if symbol and symbol.startswith("generic-ic-"):
        try:
            return _generic_ic_pins(int(symbol.rsplit("-", 1)[-1]))
        except ValueError:
            return None
    return None


def migrate_ic_unification(data):
    """
    Idempotent v1 -> v2 migration. Returns (data, changed).
    `changed` is True iff the migration touched anything (wires moved OR version stamped).
    Never raises on malformed input.
    """
    if not isinstance(data, dict):
        return data, False
    if data.get("version", 1) >= SCHEMA_VERSION:
        return data, False

    components = data.get("components") or []
    wires = data.get("schematicWires") or []

    remap = {}
    for comp in components:
        if not isinstance(comp, dict):
            continue
        spos = comp.get("schematicPos")
        if not isinstance(spos, dict):
            continue
        cx, cy = spos.get("x"), spos.get("y")
        if not isinstance(cx, (int, float)) or not isinstance(cy, (int, float)):
            continue
        family = _symbol_family(comp.get("defId", ""))
        if family is None:
            continue
        offsets = _pin_offsets_for_def(comp.get("defId", ""))
        if not offsets:
            continue
        rotation = comp.get("schematicRotation") or 0
        mirrored = bool(comp.get("schematicMirrored"))
        old_x_mag = _X_OLD[family]
        new_x_mag = _X_NEW[family]
        for x_sign, y in offsets:
            ox, oy = _apply_transform(x_sign * old_x_mag, y, rotation, mirrored)
            nx, ny = _apply_transform(x_sign * new_x_mag, y, rotation, mirrored)
            remap[(round(cx + ox), round(cy + oy))] = (cx + nx, cy + ny)

    if remap and isinstance(wires, list):
        for w in wires:
            if not isinstance(w, dict):
                continue
            for endpoint in ("start", "end"):
                pt = w.get(endpoint)
                if not isinstance(pt, dict):
                    continue
                px, py = pt.get("x"), pt.get("y")
                if not isinstance(px, (int, float)) or not isinstance(py, (int, float)):
                    continue
                new_pt = remap.get((round(px), round(py)))
                if new_pt is not None:
                    w[endpoint] = {"x": new_pt[0], "y": new_pt[1]}

    data["version"] = SCHEMA_VERSION
    return data, True
