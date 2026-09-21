"""
Optocoupler body migration (v3 → v4).

The optocoupler had a schematic symbol of its own, twice as tall as every
other IC: its pins sat two grid steps apart, at y = -20 and 20 in the part's
own frame. It is now drawn as the generic 4-pin IC body, pins one step apart
at y = 0 and 20.

Wires and flags are stored as points, so two of the pins would leave behind
whatever met them. Either pins 1 and 4 move down a step (the part stays put),
or the part moves up a step and pins 2 and 3 move up with it. Wherever
something reaches a moved pin's old spot (a wire end, a wire body under touch
wiring, a flag, another pin), a one-grid wire now runs from there to the pin.
Nothing else moves and every wire stays straight.

The first way is tried first. When the pin's new spot is already taken by
something of another net, the second way is used; a part neither keeps
intact gets the first. Every choice is checked by comparing the nets.

`migrate_optocoupler_v4(data)` is idempotent and never raises on malformed
input. Called through migrations_data.pipeline, after the v3 step.
"""

import uuid

from .schematic_v3 import (
    MAX_DECISION_TESTS, _label_points, _num, _on_body, _pin_groups, _point, _round, _straight, _transform,
    schematic_pin_points,
)

SCHEMA_VERSION = 4
DEF_ID = "def-optocoupler"
# (part shift, {pin id: (old, new)}), all in the part's own frame at rotation 0
WAYS = (
    ((0, 0), {"1": ((-60, -20), (-60, 0)), "4": ((60, -20), (60, 0))}),
    ((0, -20), {"2": ((-60, 20), (-60, 0)), "3": ((60, 20), (60, 0))}),
)


def _world(comp, x, y):
    tx, ty = _transform(x, y, comp.get("schematicRotation") or 0, bool(comp.get("schematicMirrored")))
    return (_round(comp["schematicPos"]["x"] + tx), _round(comp["schematicPos"]["y"] + ty))


def _reached(point, segments, others, touch):
    """Whether a wire, a flag or another pin meets `point`."""
    if point in others:
        return True
    for a, b in segments:
        if point in (a, b) or (touch and _on_body(point, a, b)):
            return True
    return False


def _segments(wires):
    out = []
    for w in wires:
        if isinstance(w, dict):
            a, b = _point(w.get("start")), _point(w.get("end"))
            if a is not None and b is not None:
                out.append((a, b))
    return out


def migrate_optocoupler_v4(data):
    """Idempotent v3 -> v4 migration. Returns (data, changed)."""
    if not isinstance(data, dict):
        return data, False
    version = data.get("version", 1)
    if _num(version) and version >= SCHEMA_VERSION:
        return data, False

    wires = data.get("schematicWires")
    if not isinstance(wires, list):
        wires = []
    optos = [
        c for c in data.get("components") or []
        if isinstance(c, dict) and c.get("defId") == DEF_ID
        and isinstance(c.get("schematicPos"), dict)
        and _num(c["schematicPos"].get("x")) and _num(c["schematicPos"].get("y"))
    ]
    if optos:
        pins, _ = schematic_pin_points(data)
        label_points = _label_points(data)
        labels = {p for _, p in label_points}
        touch = data.get("wiring") == "touch"
        # Pins at their current spots; each migrated part updates its own
        at = {(cid, pid): (x, y) for cid, pid, x, y in pins}
        # The same bound as the v3 wiring decision: past it the nets are not
        # compared and the first way is taken
        checked = len(wires) * (len(pins) + 2 * len(wires) + len(label_points)) <= MAX_DECISION_TESTS

        def nets(wire_list, positions):
            flat = [(cid, pid, x, y) for (cid, pid), (x, y) in positions.items()]
            return set(_pin_groups(_as_dicts(wire_list), flat, label_points, touch))

        before = nets(_segments(wires), at) if checked else None
        added = []
        for comp in optos:
            options = []
            for shift, moves in WAYS:
                segments = _segments(wires) + added
                positions = dict(at)
                jogs = []
                for pin_id, (old, new) in moves.items():
                    old_w, new_w = _world(comp, *old), _world(comp, *new)
                    positions[(comp.get("id"), pin_id)] = new_w
                    others = labels | {p for key, p in at.items() if key != (comp.get("id"), pin_id)}
                    already = (old_w, new_w) in segments or (new_w, old_w) in segments
                    if not already and _reached(old_w, segments, others, touch):
                        jogs.append((old_w, new_w))
                options.append((shift, positions, jogs))
            chosen = options[0]
            if checked:
                for option in options:
                    if nets(_segments(wires) + added + option[2], option[1]) == before:
                        chosen = option
                        break
            shift, positions, jogs = chosen
            if shift != (0, 0):
                dx, dy = _transform(*shift, comp.get("schematicRotation") or 0, bool(comp.get("schematicMirrored")))
                comp["schematicPos"] = {"x": comp["schematicPos"]["x"] + dx, "y": comp["schematicPos"]["y"] + dy}
            at = positions
            added += jogs

        wires = wires + [_straight(str(uuid.uuid4()), a, b) for a, b in added]

    data["schematicWires"] = wires
    data["version"] = SCHEMA_VERSION
    return data, True


def _as_dicts(segments):
    return [{"start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}} for a, b in segments]
