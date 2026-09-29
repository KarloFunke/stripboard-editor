"use client";

import { useMemo } from "react";
import type { LabDecoded, LabGenome } from "@/components/stripboard/autoLayout5";
import { LAB, GENOME, MOVE_STEPS, PARTS, NETS, useLiveLab } from "./lab";
import GenomeView from "./GenomeView";
import BoardView from "./BoardView";
import Player from "./Player";

// ── Section 5: one move of each kind on the example description ──
// Proposals the engine's own move generator made, recorded (lab.ts
// MOVE_STEPS), all from the same description. Each is decoded here and
// scored; the example is a decent description already, so mess is priced as
// at the end of a run.

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const without = (o: number[], pi: number) => o.filter((x) => x !== pi);

// what changed between two descriptions, in words
function classify(a: LabGenome, b: LabGenome): string | null {
  const id = (pi: number) => PARTS[pi].id;
  if (!eq(a.rot, b.rot)) { const k = b.rot.findIndex((v, i) => v !== a.rot[i]); return `${id(LAB.rigidIdx[k])} is rotated by ${((b.rot[k] - a.rot[k] + 4) % 4) * 90}°.`; }
  if (!eq(a.hv, b.hv)) { const k = b.hv.findIndex((v, i) => v !== a.hv[i]); return `${id(LAB.flexIdx[k])} is ${b.hv[k] === 1 ? "laid flat" : "stood upright"}.`; }
  if (!eq(a.br, b.br)) { const k = b.br.findIndex((v, i) => v !== a.br[i]); return `${id(LAB.flexIdx[k])} is turned around, its two ends swap.`; }
  // a pull and tie moves one part in both orders and puts its pin on the mate's strip group
  const pulled = !eq(a.gp, b.gp) && !eq(a.gn, b.gn)
    ? b.gp.find((pi) => eq(without(a.gp, pi), without(b.gp, pi)) && eq(without(a.gn, pi), without(b.gn, pi))) : undefined;
  if (pulled !== undefined && !eq(a.grp, b.grp)) {
    const n = b.grp.findIndex((v, i) => !eq(v, a.grp[i]));
    const label = b.grp[n][b.grp[n].findIndex((v, i) => v !== a.grp[n][i])];
    const i = b.gp.indexOf(pulled);
    const mate = [b.gp[i - 1], b.gp[i + 1]].find((pi) => pi !== undefined && NETS[n].pins.some((p, q) => p.pi === pi && b.grp[n][q] === label));
    if (mate !== undefined) return `${id(pulled)} is pulled next to ${id(mate)} in both orders, and its ${NETS[n].name} pin joins the strip group of ${id(mate)}: the two are asked to share a strip.`;
  }
  if (!eq(a.grp, b.grp)) {
    const n = b.grp.findIndex((v, i) => !eq(v, a.grp[i]));
    const before = new Set(a.grp[n]).size, after = new Set(b.grp[n]).size;
    const k = b.grp[n].findIndex((v, i) => v !== a.grp[n][i]);
    const pin = NETS[n].pins[k];
    if (after < before) return `Two strip groups of ${NETS[n].name} are merged: their pins are asked to share one strip.`;
    if (after > before) return `The ${NETS[n].name} pin ${pin.name} of ${id(pin.pi)} is split off into a strip group of its own.`;
    return `The ${NETS[n].name} pin ${pin.name} of ${id(pin.pi)} moves to another strip group of its net.`;
  }
  if (!eq(a.gap, b.gap)) { const pi = b.gap.findIndex((v, i) => v !== a.gap[i]); return b.gap[pi] ? `${b.gap[pi]} blank row${b.gap[pi] > 1 ? "s" : ""} below ${id(pi)} ${b.gap[pi] > 1 ? "are" : "is"} reserved.` : `The blank rows below ${id(pi)} are released.`; }
  if (!eq(a.xgap, b.xgap)) { const pi = b.xgap.findIndex((v, i) => v !== a.xgap[i]); return b.xgap[pi] ? `${b.xgap[pi]} blank column${b.xgap[pi] > 1 ? "s" : ""} right of ${id(pi)} ${b.xgap[pi] > 1 ? "are" : "is"} reserved.` : `The blank columns right of ${id(pi)} are released.`; }
  const gpC = !eq(a.gp, b.gp), gnC = !eq(a.gn, b.gn);
  if (gpC && gnC) {
    for (const pi of b.gp) {
      if (eq(without(a.gp, pi), without(b.gp, pi)) && eq(without(a.gn, pi), without(b.gn, pi))) {
        const atEnd = (o: number[]) => o[0] === pi || o[o.length - 1] === pi;
        if (PARTS[pi].isConn && atEnd(b.gp) && atEnd(b.gn)) return `${id(pi)}, a connector, is thrown to the ${b.gp[0] === pi ? "front" : "end"} of both orders, towards the opposite board edge.`;
        const i = b.gp.indexOf(pi);
        const mate = b.gp[i + 1 < b.gp.length ? i + 1 : i - 1];
        return `${id(pi)} is pulled next to ${id(mate)}, its mate on a net, in both orders.`;
      }
    }
    const d = b.gp.map((v, i) => (v !== a.gp[i] ? v : -1)).filter((v) => v >= 0);
    return `${id(d[0])} and ${id(d[1])} swap places in both orders.`;
  }
  if (gpC || gnC) {
    const o = gpC ? b.gp : b.gn, oa = gpC ? a.gp : a.gn;
    const d = o.map((v, i) => (v !== oa[i] ? v : -1)).filter((v) => v >= 0);
    return `${id(d[0])} and ${id(d[1])} swap places in the ${gpC ? "first" : "second"} order.`;
  }
  return null;
}

const E = (d: LabDecoded) => d.eBase + 400 * d.mess;
// the score with its penalty for an unbuildable board shown apart
const score = (x: LabDecoded) => x.hard > 0 ? `${(E(x) - x.hard).toFixed(1)} + ${x.hard} penalty` : E(x).toFixed(1);

// one move in words: what it changed, and what that did to the score
function describe(g: LabGenome, before: LabDecoded, after: LabDecoded): string {
  const parts: string[] = [];
  const d = (x: number) => (x > 0 ? `+${x}` : `${x}`);
  if (after.H * after.W !== before.H * before.W) parts.push(`area ${d(after.H * after.W - before.H * before.W)}`);
  if (after.wires !== before.wires) parts.push(`wires ${d(after.wires - before.wires)}`);
  if (after.wireLen !== before.wireLen) parts.push(`wire length ${d(after.wireLen - before.wireLen)}`);
  if (after.cuts !== before.cuts) parts.push(`cuts ${d(after.cuts - before.cuts)}`);
  if (after.mess !== before.mess) parts.push(`messy wires ${d(after.mess - before.mess)}`);
  if (after.starved !== before.starved) parts.push(`unreachable pins ${d(after.starved - before.starved)}`);
  const clr = (x: LabDecoded) => x.hard - 450 * x.starved;
  if (clr(after) !== clr(before)) parts.push(clr(after) > clr(before) ? "a clearance violation" : "a clearance violation resolved");
  if (Math.round(after.connEdge) !== Math.round(before.connEdge)) parts.push(after.connEdge > before.connEdge ? "a connector further from the edge" : "a connector closer to the edge");
  const dE = E(after) - E(before);
  return `${classify(GENOME, g) ?? ""} Score ${dE > 0 ? `+${dE.toFixed(1)}, worse` : dE < 0 ? `${dE.toFixed(1)}, better` : "unchanged"}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

export default function MoveDemo({ caption }: { caption?: string }) {
  const lab = useLiveLab();
  const before = useMemo(() => (lab ? lab.decode(lab.cloneG(GENOME), false).d : null), [lab]);
  const steps = useMemo(() => MOVE_STEPS.map((g) => {
    const after = lab ? lab.decode(lab.cloneG(g), false).d : null;
    return { g, after, msg: before && after ? describe(g, before, after) : classify(GENOME, g) ?? "" };
  }), [lab, before]);
  return (
    <Player
      demo="move"
      frames={steps}
      stepMs={3000}
      caption={caption}
      render={(f) => {
        const size = { rows: Math.max(before?.board.rows ?? 1, f.after?.board.rows ?? 0), cols: Math.max(before?.board.cols ?? 1, f.after?.board.cols ?? 0) };
        return (
          <>
            <div className="rounded border border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/40 p-3">
              <GenomeView g={f.g} prev={GENOME} />
            </div>
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mb-1">before{before ? `, score ${score(before)}` : ""}</p>
                {before ? <BoardView state={before.board} rows={size.rows} cols={size.cols} labels={false} /> : <div className="text-xs text-neutral-400 min-h-[8rem]">Loading the decoder.</div>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mb-1">after{f.after ? `, score ${score(f.after)}` : ""}</p>
                {f.after && <BoardView state={f.after.board} rows={size.rows} cols={size.cols} labels={false} />}
              </div>
            </div>
          </>
        );
      }}
    />
  );
}
