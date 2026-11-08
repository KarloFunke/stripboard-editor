import type { BoardPattern } from "@/types";
import { useProjectStore } from "@/store/useProjectStore";
import { confirmAction } from "@/lib/dialog";
import { track } from "@/lib/track";
import { boardView } from "./offBoard";
import { misfits, offHoles, patternSize } from "./boardPattern";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Whether the open project may go onto this board (null: plain stripboard).
 * Asks first when parts, wires or cuts would have nowhere to sit on it.
 */
export async function confirmBoard(pattern: BoardPattern | null): Promise<boolean> {
  const s = useProjectStore.getState();
  const next = { ...s.board, ...(pattern ? patternSize(pattern.map) : {}), pattern: pattern ?? undefined };
  const view = boardView(s.components, s.componentDefs, s.netAssignments).components;
  const off = misfits(next, view, s.componentDefs);
  const lost = [
    off.parts.length > 0 && `${plural(off.parts.length, "part is", "parts are")} off its edge and go${off.parts.length === 1 ? "es" : ""} back to the unplaced list`,
    off.wires.length > 0 && `${plural(off.wires.length, "link wire runs", "link wires run")} off it and ${off.wires.length === 1 ? "is" : "are"} removed`,
    off.cuts.length > 0 && `${plural(off.cuts.length, "cut has", "cuts have")} no copper to cut and ${off.cuts.length === 1 ? "is" : "are"} removed`,
  ].filter(Boolean);
  // what stays but sits where the new board has no hole
  const onBoard = { ...next, wires: next.wires.filter((w) => !off.wires.includes(w.id)) };
  const holeless = offHoles(onBoard, view.filter((c) => !off.parts.includes(c.id)), s.componentDefs).length;
  if (lost.length === 0 && holeless === 0) return true;
  const name = pattern?.name ?? "Stripboard";
  const notes = [
    lost.length > 0 && `On ${name}, ${lost.join("; ")}.`,
    holeless > 0 && `${plural(holeless, "pin or wire end lands", "pins and wire ends land")} where it has no hole, marked red until moved.`,
  ].filter(Boolean);
  return confirmAction(`Put the layout on ${name}?`, notes.join(" "), "Change board");
}

/** Puts the open project on this board, once confirmed. */
export async function switchBoard(pattern: BoardPattern | null, from: "picker" | "editor"): Promise<boolean> {
  if (!(await confirmBoard(pattern))) return false;
  const unplaced = useProjectStore.getState().components.filter((c) => c.boardPos).length;
  useProjectStore.getState().setBoardPattern(pattern);
  track("board-switch", {
    to: pattern?.builtin ?? (pattern ? (pattern.library ? "library" : "custom") : "stripboard"),
    from,
    unplaced: unplaced - useProjectStore.getState().components.filter((c) => c.boardPos).length,
  });
  return true;
}
