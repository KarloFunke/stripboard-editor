"""
A user's own boards and how they reach projects, the way parts do
(user_parts.py): a project holds a copy of a board as its board's pattern,
linked by `library: {"id": <UserBoard id>, "rev": <revision>}` until the copy
is edited in that project alone. Saving a library board can carry the change
into every copy that is still linked, in all of the owner's projects.

A board is `{"name": ..., "map": [...]}`; the map is described in the
frontend's components/stripboard/boardPattern.ts.
"""

import json
import re

MAX_BOARDS_PER_USER = 200
MAX_BOARD_BYTES = 64 * 1024
# Holes per side, as for a plain stripboard
MAX_BOARD_SIDE = 100
MAX_BOARD_NAME = 80
_HOLE_LINE = re.compile(r"^[o.]([- ][o.])*$")
_LINK_LINE = re.compile(r"^[| ]( [| ])*$")


def board_size(board_map):
    return (len(board_map) + 1) // 2, (len(board_map[0]) + 1) // 2


def validate_board(board):
    """An error message, or None for a board that can be stored."""
    if not isinstance(board, dict):
        return "Expected a board object"
    if len(json.dumps(board).encode("utf-8")) > MAX_BOARD_BYTES:
        return "This board is too large to store"
    name = board.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > MAX_BOARD_NAME:
        return f"A board needs a name of at most {MAX_BOARD_NAME} characters"
    board_map = board.get("map")
    if not isinstance(board_map, list) or not board_map or len(board_map) % 2 == 0:
        return "A board map needs an odd number of lines"
    if not all(isinstance(line, str) for line in board_map):
        return "A board map is made of lines of text"
    width = len(board_map[0])
    if width % 2 == 0 or any(len(line) != width for line in board_map):
        return "Every line of a board map must be equally long, and of odd length"
    for i, line in enumerate(board_map):
        if not (_HOLE_LINE if i % 2 == 0 else _LINK_LINE).match(line):
            return "A board map holds only o . - | and spaces"
    rows, cols = board_size(board_map)
    if rows > MAX_BOARD_SIDE or cols > MAX_BOARD_SIDE:
        return f"A board has at most {MAX_BOARD_SIDE} rows and columns"
    if "o" not in "".join(board_map[::2]):
        return "A board needs at least one hole"
    return None


def stored_board(board):
    """What the library keeps of a board: its name and copper. Mirrors
    boardPayload in the frontend."""
    return {"name": board["name"].strip(), "map": board["map"]}


def project_copy(board, board_id, rev):
    return {**stored_board(board), "library": {"id": board_id, "rev": rev}}


def _pattern(data):
    board = data.get("board") if isinstance(data, dict) else None
    pattern = board.get("pattern") if isinstance(board, dict) else None
    return pattern if isinstance(pattern, dict) else None


def is_linked(data, board_id):
    """Whether the project's board is a linked copy of library board `board_id`."""
    pattern = _pattern(data)
    lib = pattern.get("library") if pattern else None
    return isinstance(lib, dict) and lib.get("id") == board_id


def placed_count(data):
    return sum(1 for c in data.get("components") or [] if isinstance(c, dict) and c.get("boardPos") is not None)


def apply_to_project(data, board_id, board, rev):
    """
    Puts the new version of the library board on a project whose board is a
    linked copy. Parts, wires and cuts stay where they are; the editor sends
    whatever no longer fits the board back off it when the project is next
    opened. Returns whether anything changed.
    """
    if not is_linked(data, board_id):
        return False
    rows, cols = board_size(board["map"])
    data["board"] = {**data["board"], "rows": rows, "cols": cols, "pattern": project_copy(board, board_id, rev)}
    return True
