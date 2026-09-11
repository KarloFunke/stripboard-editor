"""
Schematic straight-wire migration (v2 → v3).

v2 wires could be L-shaped: a start, an end, and a bend derived from
`routeDirection`. v3 wires are always a single horizontal or vertical
segment, so an L becomes two wires meeting at the old bend. Under the v2
rules the bend was a connection point (a pin or another wire end sitting on
it joined the net); making it a real endpoint keeps exactly that
connectivity, so this migration is lossless.

Zero-length wires are dropped: the only ones that meant anything sat where
two pins overlap, and pins on one point are connected in their own right
under the v3 rules.

v3 also introduces `netLabels` (ground / power flags and net labels); a
project without them gets an empty list. And it decides the wiring rule
set. Under "touch" wiring whatever touches is connected (a pin on a wire's
body, a wire end resting on another wire); under "classic" only wire ends
connect. A project gets "touch" when applying the touch rules would not join
any two of its nets, so it simply behaves like a new project; only a drawing
whose nets would actually merge stays "classic", which the user can switch
in the editor after seeing what joins. The decision needs the schematic pin
positions of every part; built-in symbols come from symbol_pins.json
(generated from the frontend's symbol table), parametric and custom
footprint symbols from the same formulas the frontend uses.

`migrate_schematic_v3(data)` is idempotent and never raises on malformed
input. Called through migrations_data.pipeline from:
  - the management command (one-shot, all rows)
  - the serializer save hooks (stale v2 frontends / re-uploaded exports)
  - project_fork and the stateless /projects/migrate/ endpoint
"""

import json
import math
import os
import uuid

SCHEMA_VERSION = 3
G = 20
MAX_DECISION_TESTS = 2_000_000

with open(os.path.join(os.path.dirname(__file__), "symbol_pins.json")) as _f:
    _PINS = json.load(_f)
DEFAULT_DEF_SYMBOL = _PINS["defs"]          # defId -> symbolId
STATIC_SYMBOL_PINS = _PINS["symbols"]       # symbolId -> [[pinId, x, y], ...]


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _round(v):
    """Round half up, as the frontend's Math.round does. Python's round() is
    half-to-even, so the two disagree on coordinates ending in exactly .5 and
    a wire would be written off the pin it keys to."""
    return math.floor(v + 0.5)


def _point(p):
    """(x, y) as ints if p is a well-formed point, else None."""
    if not isinstance(p, dict) or not _num(p.get("x")) or not _num(p.get("y")):
        return None
    return (_round(p["x"]), _round(p["y"]))


def _straight(wire_id, a, b):
    return {"id": wire_id, "start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}}


def split_wires(wires):
    """
    Straight wires pass through (minus `routeDirection`), L-shaped wires are
    split at their bend, degenerate ones are dropped. Returns (wires, changed).
    """
    out = []
    changed = False
    for w in wires:
        if not isinstance(w, dict):
            changed = True
            continue
        a, b = _point(w.get("start")), _point(w.get("end"))
        if a is None or b is None or a == b:
            changed = True
            continue
        wire_id = w.get("id") or str(uuid.uuid4())
        if a[0] == b[0] or a[1] == b[1]:
            if "routeDirection" in w or w.get("id") != wire_id:
                changed = True
            out.append(_straight(wire_id, a, b))
            continue
        # L-shaped: the bend sits at (end.x, start.y) for horizontal-first,
        # (start.x, end.y) for vertical-first (the v2 default was horizontal-first).
        vertical_first = w.get("routeDirection") == "vertical-first"
        bend = (a[0], b[1]) if vertical_first else (b[0], a[1])
        out.append(_straight(wire_id, a, bend))
        out.append(_straight(str(uuid.uuid4()), bend, b))
        changed = True
    return out, changed


# ── Schematic pin positions ───────────────────────────────

def _generic_ic_pins(n):
    """Mirrors createGenericIcSymbol: left top→bottom, right bottom→top, x = ±60."""
    per_side = (n + 1) // 2
    right = n - per_side
    extent = (per_side - 1) * G
    y_start = -(extent // (2 * G)) * G
    pins = [(str(i + 1), -60, y_start + i * G) for i in range(per_side)]
    pins += [(str(per_side + i + 1), 60, y_start + extent - i * G) for i in range(right)]
    return pins


def _connector_pins(n):
    """Mirrors createConnectorSymbol: pins on the left at x = -40."""
    extent = (n - 1) * G
    y_start = -(extent // (2 * G)) * G
    return [(str(i + 1), -40, y_start + i * G) for i in range(n)]


def _footprint_symbol_pins(def_):
    """Mirrors createFootprintSymbol: the stripboard footprint, one grid step per hole."""
    pins = def_.get("pins")
    if not isinstance(pins, list):
        return None
    try:
        max_row = int(def_.get("height", 1)) - 1
        max_col = int(def_.get("width", 1)) - 1
        off_x = (max_col // 2) * G
        off_y = (max_row // 2) * G
        return [(str(p["id"]), int(p["offsetCol"]) * G - off_x, int(p["offsetRow"]) * G - off_y) for p in pins]
    except (KeyError, TypeError, ValueError):
        return None


def _symbol_pins(symbol_id, def_=None):
    """[(pinId, x, y)] at rotation 0, or None if the symbol is unknown."""
    if symbol_id in STATIC_SYMBOL_PINS:
        return [(str(p[0]), p[1], p[2]) for p in STATIC_SYMBOL_PINS[symbol_id]]
    if symbol_id.startswith("generic-ic-"):
        try:
            return _generic_ic_pins(int(symbol_id.rsplit("-", 1)[-1]))
        except ValueError:
            return None
    if symbol_id.startswith("connector-"):
        try:
            return _connector_pins(int(symbol_id.rsplit("-", 1)[-1]))
        except ValueError:
            return None
    if symbol_id.startswith("custom-footprint-") and def_ is not None:
        return _footprint_symbol_pins(def_)
    return None


def _transform(x, y, rotation, mirrored):
    """Mirror (flip x) then rotate, as the frontend's transformPoint does."""
    if mirrored:
        x = -x
    if rotation == 90:
        return (-y, x)
    if rotation == 180:
        return (-x, -y)
    if rotation == 270:
        return (y, -x)
    return (x, y)


def schematic_pin_points(data):
    """
    [(componentId, pinId, x, y)] for every resolvable pin, and whether every
    component could be resolved.
    """
    custom = {}
    for d in data.get("componentDefs") or []:
        if isinstance(d, dict) and d.get("id"):
            custom[d["id"]] = d
    out = []
    complete = True
    for comp in data.get("components") or []:
        if not isinstance(comp, dict):
            continue
        pos = comp.get("schematicPos")
        if not isinstance(pos, dict) or not _num(pos.get("x")) or not _num(pos.get("y")):
            continue
        def_id = comp.get("defId")
        # Built-in parts win over any copy of them a project may carry, as
        # the frontend does; only genuinely custom defs come from the project
        if def_id in DEFAULT_DEF_SYMBOL:
            symbol, def_ = DEFAULT_DEF_SYMBOL[def_id], None
        else:
            def_ = custom.get(def_id)
            symbol = def_.get("symbol") if def_ else None
        pins = _symbol_pins(symbol, def_) if isinstance(symbol, str) else None
        if pins is None:
            complete = False
            continue
        rotation = comp.get("schematicRotation") or 0
        mirrored = bool(comp.get("schematicMirrored"))
        for pin_id, px, py in pins:
            tx, ty = _transform(px, py, rotation, mirrored)
            out.append((comp.get("id"), pin_id, _round(pos["x"] + tx), _round(pos["y"] + ty)))
    return out, complete


# ── Wiring rule set ───────────────────────────────────────

class _UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, k):
        self.parent.setdefault(k, k)
        root = k
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[k] != root:
            self.parent[k], k = root, self.parent[k]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _on_body(p, a, b):
    """p strictly inside the axis-aligned segment ab."""
    if a[0] == b[0]:
        return p[0] == a[0] and min(a[1], b[1]) < p[1] < max(a[1], b[1])
    if a[1] == b[1]:
        return p[1] == a[1] and min(a[0], b[0]) < p[0] < max(a[0], b[0])
    return False


def _label_points(data):
    """[(name, (x, y))] for every well-formed net label (flag)."""
    out = []
    for l in data.get("netLabels") or []:
        if not isinstance(l, dict):
            continue
        pos = _point(l.get("pos"))
        name = l.get("name")
        if pos is None or not isinstance(name, str):
            continue
        out.append((name.strip(), pos))
    return out


def _pin_groups(wires, pins, labels, touch):
    """
    Nets as frozensets of (componentId, pinId), with at least two pins.
    Wire ends join, as do flags of the same name and pins on one point;
    under `touch` every pin, flag or wire end lying on a wire's body joins
    that wire too.
    """
    uf = _UnionFind()
    ends = []
    for w in wires:
        a = (w["start"]["x"], w["start"]["y"])
        b = (w["end"]["x"], w["end"]["y"])
        uf.union(a, b)
        ends.append((a, b))
    by_name = {}
    for name, pos in labels:
        if name:
            by_name.setdefault(name, []).append(pos)
    for points in by_name.values():
        for p in points[1:]:
            uf.union(points[0], p)
    if touch:
        candidates = [(x, y) for _, _, x, y in pins] + [p for a, b in ends for p in (a, b)] + [p for _, p in labels]
        for a, b in ends:
            for p in candidates:
                if _on_body(p, a, b):
                    uf.union(a, p)
    groups = {}
    for comp_id, pin_id, x, y in pins:
        groups.setdefault(uf.find((x, y)), set()).add((comp_id, pin_id))
    return [frozenset(g) for g in groups.values() if len(g) >= 2]


def decide_wiring(data):
    """
    "touch" when the touch rules would leave every net of this drawing
    exactly as it is (nothing joins, nothing grows), else "classic". A
    drawing with a part whose pins cannot be resolved keeps "classic" to be
    safe.
    """
    wires = [w for w in data.get("schematicWires") or [] if isinstance(w, dict)]
    if not wires:
        return "touch"
    pins, complete = schematic_pin_points(data)
    if not complete:
        return "classic"
    labels = _label_points(data)
    # Testing every wire against every candidate point is quadratic, and this
    # runs on data posted to /projects/migrate/. Far past any real drawing
    # (the largest of 1086 real projects needs ~450k tests) the answer is not
    # worth the time, and "classic" is the safe one: it joins nothing.
    if len(wires) * (len(pins) + 2 * len(wires) + len(labels)) > MAX_DECISION_TESTS:
        return "classic"
    base = set(_pin_groups(wires, pins, labels, touch=False))
    touch = set(_pin_groups(wires, pins, labels, touch=True))
    return "touch" if base == touch else "classic"


def migrate_schematic_v3(data):
    """
    Idempotent v2 -> v3 migration. Returns (data, changed).
    `changed` is True iff the migration touched anything (wires rewritten,
    netLabels added, or version stamped). Never raises on malformed input.
    """
    if not isinstance(data, dict):
        return data, False
    version = data.get("version", 1)
    if _num(version) and version >= SCHEMA_VERSION:
        # Already on v3 but without a wiring decision (migrated by an earlier
        # build): decide now, touch nothing else
        if data.get("wiring") in ("classic", "touch"):
            return data, False
        try:
            data["wiring"] = decide_wiring(data)
        except Exception:
            data["wiring"] = "classic"
        return data, True

    wires = data.get("schematicWires")
    if isinstance(wires, list):
        data["schematicWires"], _ = split_wires(wires)
    else:
        data["schematicWires"] = []

    if not isinstance(data.get("netLabels"), list):
        data["netLabels"] = []
    if data.get("wiring") not in ("classic", "touch"):
        try:
            data["wiring"] = decide_wiring(data)
        except Exception:
            data["wiring"] = "classic"

    data["version"] = SCHEMA_VERSION
    return data, True
