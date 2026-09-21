import { Component, ComponentDef, Cut } from "@/types";
import { getRotatedPinPositions } from "./boardLayout";

/** The stretch of one strip between two neighbouring pins of a rigid part. */
interface PinSpan {
  row: number;
  from: number;
  to: number;
  pins: [string, string];
}

function pinSpans(comp: Component, def: ComponentDef): PinSpan[] {
  if (def.flexible || !comp.boardPos) return [];
  const rows = new Map<number, { pinId: string; col: number }[]>();
  for (const p of getRotatedPinPositions(def, comp.boardPos, comp.rotation)) {
    rows.set(p.row, [...(rows.get(p.row) ?? []), p]);
  }
  const spans: PinSpan[] = [];
  for (const [row, pins] of rows) {
    pins.sort((a, b) => a.col - b.col);
    for (let i = 1; i < pins.length; i++) {
      spans.push({ row, from: pins[i - 1].col, to: pins[i].col, pins: [pins[i - 1].pinId, pins[i].pinId] });
    }
  }
  return spans;
}

const inSpan = (cut: Cut, s: PinSpan) =>
  cut.row === s.row && cut.col < s.to && (cut.kind === "hole" ? cut.col > s.from : cut.col >= s.from);

export const sameCut = (a: Cut, b: Cut) =>
  a.row === b.row && a.col === b.col && (a.kind === "hole") === (b.kind === "hole");

/**
 * The cuts that belong to a part: those on a strip between two of its own
 * pins. Nothing else can use that stretch of copper, so they come and go and
 * move with the part. Told by position alone, so a cut the layouter made and
 * one drawn by hand count the same.
 */
export function bodyCuts(cuts: Cut[], comp: Component, def: ComponentDef): Cut[] {
  const spans = pinSpans(comp, def);
  return spans.length === 0 ? [] : cuts.filter((c) => spans.some((s) => inSpan(c, s)));
}

/**
 * The cuts a part needs under its body where it now sits: one per stretch of
 * strip that would otherwise short two of its pins. Not between pins the part
 * joins itself (same pin id), not between pins of one net, and not where a
 * cut already is.
 */
export function missingBodyCuts(
  cuts: Cut[],
  comp: Component,
  def: ComponentDef,
  netOf: (pinId: string) => string | undefined,
  drilled: boolean,
  holeTaken: (row: number, col: number) => boolean
): Cut[] {
  const added: Cut[] = [];
  for (const s of pinSpans(comp, def)) {
    if (s.pins[0] === s.pins[1]) continue;
    const net = netOf(s.pins[0]);
    if (net && net === netOf(s.pins[1])) continue;
    if (cuts.some((c) => inSpan(c, s))) continue;

    const mid = (s.from + s.to) / 2;
    const holes: number[] = [];
    for (let col = s.from + 1; col < s.to; col++) {
      if (!holeTaken(s.row, col)) holes.push(col);
    }
    holes.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    added.push(
      drilled && holes.length > 0
        ? { row: s.row, col: holes[0], kind: "hole" }
        : { row: s.row, col: Math.floor((s.from + s.to - 1) / 2), kind: "between" }
    );
  }
  return added;
}
