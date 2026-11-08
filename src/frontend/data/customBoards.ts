// Boards of the user's own: made in the board editor, kept in one project or
// in the user's library. Like a custom part, a project never points at the
// library; it holds a copy, linked by `library: { id, rev }`.
import type { BoardPattern } from "@/types";
import type { BoardDesign, LibraryBoard } from "@/lib/api";
import { mapError } from "@/components/stripboard/boardPattern";

/** A library board as a project's board. */
export function libraryPattern(lb: LibraryBoard): BoardPattern {
  return { name: lb.board.name, map: lb.board.map, library: { id: lb.id, rev: lb.rev } };
}

/** What a library board stores: the name and the copper. */
export function boardPayload(pattern: BoardPattern | BoardDesign): BoardDesign {
  return { name: pattern.name.trim(), map: pattern.map };
}

// Boards files: a whole library or a single board, to keep or to give away
export const BOARDS_FILE_FORMAT = "stripboard-editor-boards";

export function boardsFile(boards: (BoardPattern | BoardDesign)[]): string {
  return JSON.stringify({ format: BOARDS_FILE_FORMAT, version: 1, boards: boards.map(boardPayload) }, null, 2);
}

export function readBoardsFile(text: string): BoardDesign[] {
  let data: { format?: unknown; boards?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON");
  }
  if (data?.format !== BOARDS_FILE_FORMAT || !Array.isArray(data.boards)) {
    throw new Error("This is not a boards file from the Stripboard Editor");
  }
  const boards = data.boards as BoardDesign[];
  const bad = boards.findIndex((b) => typeof b?.name !== "string" || mapError(b.map) !== null);
  if (bad >= 0) throw new Error(`Board ${bad + 1} in this file is damaged`);
  return boards;
}
