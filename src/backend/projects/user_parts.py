"""
A user's own part library and how its parts reach projects.

Projects never point at the library: they hold copies. A copy linked to a
library part carries `library: {"id": <UserPart id>, "rev": <revision>}`,
and editing it inside one project removes that link (the frontend does
that). Saving a library part can carry the change into every copy that is
still linked, in all of the owner's projects.
"""

import hashlib
import json
import re

MAX_PARTS_PER_USER = 500
MAX_PART_BYTES = 64 * 1024
# Holes per side of a part, and the pin count of a numbered body symbol
MAX_PART_SIDE = 64
# Symbols the editor makes to size: the number is a pin count it draws
_NUMBERED_SYMBOL = re.compile(r"^(generic-ic|sip-ic|connector)-(\d+)$")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_str(part, key, required=False):
    value = part.get(key)
    return isinstance(value, str) if required or value is not None else True


def footprint_changed(a, b):
    """Whether the part sits differently on the board, so placed copies no
    longer fit. Pin names are only labels; where the legs go is what counts."""
    def legs(d):
        pins = d.get("pins") if isinstance(d.get("pins"), list) else []
        return [(p.get("id"), p.get("offsetRow"), p.get("offsetCol")) for p in pins if isinstance(p, dict)]
    return any(a.get(k) != b.get(k) for k in ("width", "height", "bodyCells")) or legs(a) != legs(b)


def validate_part(part):
    """An error message, or None for a part that can be stored."""
    if not isinstance(part, dict):
        return "Expected a part object"
    size = len(json.dumps(part).encode("utf-8"))
    if size > MAX_PART_BYTES:
        return f"Part too large ({size} bytes). Maximum is {MAX_PART_BYTES} bytes."
    name = part.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 255:
        return "A part needs a name of at most 255 characters"
    if not all(_is_str(part, k) for k in ("group", "description")):
        return "Group and description must be text"
    if not _is_str(part, "defaultLabelPrefix", required=True):
        return "A part needs a label prefix"
    symbol = part.get("symbol")
    if not isinstance(symbol, str) or not symbol:
        return "A part needs a symbol"
    m = _NUMBERED_SYMBOL.match(symbol)
    if m and int(m.group(2)) > MAX_PART_SIDE:
        return f"A body symbol can have at most {MAX_PART_SIDE} pins"
    for key in ("width", "height"):
        value = part.get(key)
        if not _is_int(value) or value < 1 or value > MAX_PART_SIDE:
            return f"A part needs a whole {key} between 1 and {MAX_PART_SIDE}"
    pins = part.get("pins")
    if not isinstance(pins, list) or not pins:
        return "A part needs at least one pin"
    for pin in pins:
        if not isinstance(pin, dict) or not isinstance(pin.get("id"), str) or not isinstance(pin.get("name"), str):
            return "Every pin needs an id and a name"
        row, col = pin.get("offsetRow"), pin.get("offsetCol")
        if not (_is_int(row) and _is_int(col) and 0 <= row < part["height"] and 0 <= col < part["width"]):
            return "Every pin must sit inside the part"
    body = part.get("bodyCells")
    if body is not None and not (
        isinstance(body, list)
        and all(isinstance(c, dict) and _is_int(c.get("row")) and _is_int(c.get("col")) for c in body)
    ):
        return "Body cells must be rows and columns"
    spec = part.get("spec")
    if spec is not None and not (
        isinstance(spec, dict) and isinstance(spec.get("footprint"), dict) and isinstance(spec["footprint"].get("kind"), str)
        and _is_str(spec, "symbol")
        and (spec.get("pins") is None or (isinstance(spec["pins"], list) and all(isinstance(p, str) for p in spec["pins"])))
    ):
        return "The part's body description is not valid"
    return None


def project_copy(part, def_id, part_id, rev):
    """The library part as a project's copy with the id `def_id`."""
    out = {k: v for k, v in part.items() if k != "library"}
    out["id"] = def_id
    # A grid part's symbol is drawn from its own footprint and named after it
    if str(part.get("symbol", "")).startswith("custom-footprint-"):
        out["symbol"] = f"custom-footprint-{def_id}"
    out["library"] = {"id": part_id, "rev": rev}
    return out


def linked_copies(data, part_id):
    """The project's copies that are linked to library part `part_id`."""
    defs = data.get("componentDefs") if isinstance(data, dict) else None
    if not isinstance(defs, list):
        return []
    return [
        d for d in defs
        if isinstance(d, dict) and isinstance(d.get("library"), dict) and d["library"].get("id") == part_id
    ]


def placed_count(data, def_ids):
    return sum(
        1 for c in data.get("components") or []
        if isinstance(c, dict) and c.get("defId") in def_ids and c.get("boardPos") is not None
    )


def apply_to_project(data, part_id, part, rev):
    """
    Replaces every linked copy of the library part in one project's data.
    Placed parts of a copy whose footprint changed go back to the unplaced
    list, as they do when a package change no longer fits, and net
    assignments drop pins the part no longer has. Mirrors replaceDefs in the
    frontend. Returns whether anything changed.
    """
    defs = data.get("componentDefs") if isinstance(data, dict) else None
    if not isinstance(defs, list):
        return False
    changed = False
    linked = {id(d) for d in linked_copies(data, part_id)}
    pin_ids = {}
    for i, old in enumerate(defs):
        if id(old) not in linked:
            continue
        new = project_copy(part, old.get("id"), part_id, rev)
        if footprint_changed(old, new):
            for comp in data.get("components") or []:
                if isinstance(comp, dict) and comp.get("defId") == old.get("id") and comp.get("boardPos") is not None:
                    comp["boardPos"] = None
                    for key in ("footprintOverride", "flexibleEndPos", "package"):
                        comp.pop(key, None)
        defs[i] = new
        pin_ids[old.get("id")] = {p["id"] for p in new["pins"]}
        changed = True
    assignments = data.get("netAssignments")
    if pin_ids and isinstance(assignments, list):
        def_of = {c.get("id"): c.get("defId") for c in data.get("components") or [] if isinstance(c, dict)}
        data["netAssignments"] = [
            a for a in assignments
            if not isinstance(a, dict)
            or def_of.get(a.get("componentId")) not in pin_ids
            or a.get("pinId") in pin_ids[def_of[a["componentId"]]]
        ]
    return changed


def stored_part(part):
    """What the library keeps of a part: no project id and no link. Mirrors
    libraryPayload in the frontend."""
    out = {k: v for k, v in part.items() if k != "library"}
    out["id"] = "library-part"
    if str(part.get("symbol", "")).startswith("custom-footprint-"):
        out["symbol"] = "custom-footprint-library-part"
    return out


def part_key(part):
    """Identical parts share a key, whatever project or id they carry."""
    return hashlib.sha1(json.dumps(stored_part(part), sort_keys=True).encode("utf-8")).hexdigest()[:16]


def _unlinked_customs(data, library_ids):
    """The project's own custom parts that no library part of this user covers."""
    for d in data.get("componentDefs") or [] if isinstance(data, dict) else []:
        if not isinstance(d, dict) or str(d.get("id", "")).startswith("def-"):
            continue
        lib = d.get("library")
        if isinstance(lib, dict) and lib.get("id") in library_ids:
            continue
        if validate_part(d) is None:
            yield d


def found_in_projects(projects, library_ids):
    """
    Custom parts that live only inside the owner's projects, one entry per
    distinct part, each with the projects that hold it.
    """
    groups = {}
    for project in projects:
        for d in _unlinked_customs(project.data, library_ids):
            key = part_key(d)
            group = groups.setdefault(key, {"key": key, "part": stored_part(d), "projects": []})
            if not any(p["edit_uuid"] == str(project.edit_uuid) for p in group["projects"]):
                group["projects"].append({"edit_uuid": str(project.edit_uuid), "name": project.name})
    return list(groups.values())


def link_copies(data, key, part_id, library_ids):
    """Links every unlinked copy of the part with `key` to library part `part_id`."""
    linked = 0
    for d in _unlinked_customs(data, library_ids):
        if part_key(d) == key:
            d["library"] = {"id": part_id, "rev": 1}
            linked += 1
    return linked
