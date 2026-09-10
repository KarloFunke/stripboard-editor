"use client";

import { useMemo, useRef, useState } from "react";
import type { LabGenome } from "@/components/stripboard/autoLayout5";
import { LAB, GENOME, PARTS, NETS } from "./lab";
import GenomeView from "./GenomeView";
import BoardView from "./BoardView";

// ── Section 5: one move at a time on the example description ──
// The engine's own move generator proposes a change of the requested kind;
// the board re-decodes and the score moves. Keep it or undo it. The example
// is a decent description already, so mess is priced as at the end of a run.

type Kind = "swapFirst" | "swapSecond" | "swapBoth" | "pull" | "throw" | "rotate" | "flip" | "turn" | "group" | "gap";
const BUTTONS: { kind: Kind; label: string }[] = [
  { kind: "swapFirst", label: "Swap in the first order" },
  { kind: "swapSecond", label: "Swap in the second order" },
  { kind: "swapBoth", label: "Swap in both" },
  { kind: "pull", label: "Pull next to a net mate" },
  { kind: "flip", label: "Flat or upright" },
  { kind: "turn", label: "Turn around" },
  { kind: "group", label: "Merge or split a strip group" },
  { kind: "gap", label: "Reserve or release a blank line" },
  { kind: "rotate", label: "Rotate a rigid component" },
  { kind: "throw", label: "Throw a connector" },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const without = (o: number[], pi: number) => o.filter((x) => x !== pi);

// what changed between two descriptions, in words
function classify(a: LabGenome, b: LabGenome): { kind: Kind; what: string } | null {
  const id = (pi: number) => PARTS[pi].id;
  if (!eq(a.rot, b.rot)) { const k = b.rot.findIndex((v, i) => v !== a.rot[i]); return { kind: "rotate", what: `${id(LAB.rigidIdx[k])} is rotated by ${((b.rot[k] - a.rot[k] + 4) % 4) * 90}°.` }; }
  if (!eq(a.hv, b.hv)) { const k = b.hv.findIndex((v, i) => v !== a.hv[i]); return { kind: "flip", what: `${id(LAB.flexIdx[k])} is ${b.hv[k] === 1 ? "laid flat" : "stood upright"}.` }; }
  if (!eq(a.br, b.br)) { const k = b.br.findIndex((v, i) => v !== a.br[i]); return { kind: "turn", what: `${id(LAB.flexIdx[k])} is turned around, its two ends swap.` }; }
  if (!eq(a.grp, b.grp)) {
    const n = b.grp.findIndex((v, i) => !eq(v, a.grp[i]));
    const before = new Set(a.grp[n]).size, after = new Set(b.grp[n]).size;
    const k = b.grp[n].findIndex((v, i) => v !== a.grp[n][i]);
    const pin = NETS[n].pins[k];
    if (after < before) return { kind: "group", what: `Two strip groups of ${NETS[n].name} are merged: their pins are asked to share one strip.` };
    if (after > before) return { kind: "group", what: `The ${NETS[n].name} pin ${pin.name} of ${id(pin.pi)} is split off into a strip group of its own.` };
    return { kind: "group", what: `The ${NETS[n].name} pin ${pin.name} of ${id(pin.pi)} moves to another strip group of its net.` };
  }
  if (!eq(a.gap, b.gap)) { const pi = b.gap.findIndex((v, i) => v !== a.gap[i]); return { kind: "gap", what: b.gap[pi] ? `${b.gap[pi]} blank row${b.gap[pi] > 1 ? "s" : ""} below ${id(pi)} ${b.gap[pi] > 1 ? "are" : "is"} reserved.` : `The blank rows below ${id(pi)} are released.` }; }
  if (!eq(a.xgap, b.xgap)) { const pi = b.xgap.findIndex((v, i) => v !== a.xgap[i]); return { kind: "gap", what: b.xgap[pi] ? `${b.xgap[pi]} blank column${b.xgap[pi] > 1 ? "s" : ""} right of ${id(pi)} ${b.xgap[pi] > 1 ? "are" : "is"} reserved.` : `The blank columns right of ${id(pi)} are released.` }; }
  const gpC = !eq(a.gp, b.gp), gnC = !eq(a.gn, b.gn);
  if (gpC && gnC) {
    for (const pi of b.gp) {
      if (eq(without(a.gp, pi), without(b.gp, pi)) && eq(without(a.gn, pi), without(b.gn, pi))) {
        const atEnd = (o: number[]) => o[0] === pi || o[o.length - 1] === pi;
        if (PARTS[pi].isConn && atEnd(b.gp) && atEnd(b.gn)) return { kind: "throw", what: `${id(pi)}, a connector, is thrown to the ${b.gp[0] === pi ? "front" : "end"} of both orders, towards the opposite board edge.` };
        const i = b.gp.indexOf(pi);
        const mate = b.gp[i + 1 < b.gp.length ? i + 1 : i - 1];
        return { kind: "pull", what: `${id(pi)} is pulled next to ${id(mate)}, its mate on a net, in both orders.` };
      }
    }
    const d = b.gp.map((v, i) => (v !== a.gp[i] ? v : -1)).filter((v) => v >= 0);
    return { kind: "swapBoth", what: `${id(d[0])} and ${id(d[1])} swap places in both orders.` };
  }
  if (gpC || gnC) {
    const o = gpC ? b.gp : b.gn, oa = gpC ? a.gp : a.gn;
    const d = o.map((v, i) => (v !== oa[i] ? v : -1)).filter((v) => v >= 0);
    return { kind: gpC ? "swapFirst" : "swapSecond", what: `${id(d[0])} and ${id(d[1])} swap places in the ${gpC ? "first" : "second"} order.` };
  }
  return null;
}

export default function MoveDemo({ caption }: { caption?: string }) {
  const rng = useRef(mulberry32(42));
  const [cur, setCur] = useState<LabGenome>(() => LAB.cloneG(GENOME));
  const [trial, setTrial] = useState<{ g: LabGenome; what: string; kind: Kind } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const before = useMemo(() => LAB.decode(LAB.cloneG(cur), false).d, [cur]);
  const after = useMemo(() => (trial ? LAB.decode(LAB.cloneG(trial.g), false).d : null), [trial]);
  const E = (d: NonNullable<typeof before>) => d.eBase + 400 * d.mess;
  const propose = (kind: Kind) => {
    for (let t = 0; t < 400; t++) {
      const g2 = LAB.mutate(cur, rng.current);
      if (!g2) continue;
      const c = classify(cur, g2);
      if (c && c.kind === kind) { setTrial({ g: g2, what: c.what, kind }); setNote(null); return; }
    }
    setNote("The move generator found no change of that kind here.");
  };
  const size = { rows: Math.max(before?.board.rows ?? 1, after?.board.rows ?? 0), cols: Math.max(before?.board.cols ?? 1, after?.board.cols ?? 0) };
  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";
  const parts: string[] = [];
  if (before && after) {
    const d = (x: number) => (x > 0 ? `+${x}` : `${x}`);
    if (after.H * after.W !== before.H * before.W) parts.push(`area ${d(after.H * after.W - before.H * before.W)}`);
    if (after.wires !== before.wires) parts.push(`wires ${d(after.wires - before.wires)}`);
    if (after.wireLen !== before.wireLen) parts.push(`wire length ${d(after.wireLen - before.wireLen)}`);
    if (after.cuts !== before.cuts) parts.push(`cuts ${d(after.cuts - before.cuts)}`);
    if (after.mess !== before.mess) parts.push(`messy wires ${d(after.mess - before.mess)}`);
    if (after.starved !== before.starved) parts.push(`unreachable pins ${d(after.starved - before.starved)}`);
    const clr = (x: typeof before) => x.hard - 450 * x.starved;
    if (clr(after) !== clr(before)) parts.push(clr(after) > clr(before) ? "a clearance violation" : "a clearance violation resolved");
    if (Math.round(after.connEdge) !== Math.round(before.connEdge)) parts.push(after.connEdge > before.connEdge ? "a connector further from the edge" : "a connector closer to the edge");
  }
  const dE = before && after ? E(after) - E(before) : 0;
  // the score with its penalty for an unbuildable board shown apart
  const score = (x: NonNullable<typeof before>) => x.hard > 0 ? `${(E(x) - x.hard).toFixed(1)} + ${x.hard} penalty` : E(x).toFixed(1);
  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {BUTTONS.map((b) => <button key={b.kind} className={btn} onClick={() => propose(b.kind)}>{b.label}</button>)}
        <span className="ml-auto inline-flex gap-2">
          <button className={btn} onClick={() => { if (trial && after) setCur(trial.g); setTrial(null); }} disabled={!trial || !after}>Keep</button>
          <button className={btn} onClick={() => setTrial(null)} disabled={!trial}>Undo</button>
          <button className={btn} onClick={() => { setCur(LAB.cloneG(GENOME)); setTrial(null); setNote(null); }}>Reset</button>
        </span>
      </div>
      <div className="rounded border border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/40 p-3">
        <GenomeView g={trial ? trial.g : cur} prev={trial ? cur : undefined} />
      </div>
      <div className="mt-3 flex flex-col md:flex-row gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mb-1">before{before ? `, score ${score(before)}` : ""}</p>
          {before && <BoardView state={before.board} rows={size.rows} cols={size.cols} labels={false} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mb-1">{after ? `after, score ${score(after)}` : "after"}</p>
          {after ? <BoardView state={after.board} rows={size.rows} cols={size.cols} labels={false} /> : <div className="text-xs text-neutral-400 min-h-[8rem]">{trial ? "Cannot be built; rejected outright." : "Pick a move above."}</div>}
        </div>
      </div>
      <div className="mt-2 min-h-[2.5rem] text-sm text-neutral-800 dark:text-neutral-200 leading-relaxed">
        {trial
          ? `${trial.what}${after && before ? ` Score ${dE > 0 ? `+${dE.toFixed(1)}, worse` : dE < 0 ? `${dE.toFixed(1)}, better` : "unchanged"}${parts.length ? `: ${parts.join(", ")}` : ""}.` : ""}`
          : note ?? "Each button asks the layouter's own move generator for one change of that kind."}
      </div>
      {caption && <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
