"use client";

import { useState } from "react";
import { trackDemo } from "./trackDemo";

// ── Sequence pair: two orderings of the components describe a whole packing ──
// For any two components a and b: a before b in both orderings means a is left
// of b; a before b in the first but after b in the second means a is above
// b. Every component then sits as far up and left as those relations allow.

const PARTS = [
  { id: "A", w: 3, h: 2, color: "#b45309" },
  { id: "B", w: 2, h: 3, color: "#0f766e" },
  { id: "C", w: 4, h: 1, color: "#1d4ed8" },
  { id: "D", w: 1, h: 2, color: "#7e22ce" },
  { id: "E", w: 2, h: 2, color: "#be123c" },
];
const CELL = 24;

function pack(seqP: string[], seqN: string[]) {
  const posP = new Map(seqP.map((id, i) => [id, i]));
  const posN = new Map(seqN.map((id, i) => [id, i]));
  const byId = new Map(PARTS.map((p) => [p.id, p]));
  const leftOf = (a: string, b: string) => posP.get(a)! < posP.get(b)! && posN.get(a)! < posN.get(b)!;
  const above = (a: string, b: string) => posP.get(a)! < posP.get(b)! && posN.get(a)! > posN.get(b)!;
  const x = new Map<string, number>(), y = new Map<string, number>();
  // longest path in first-sequence order (every relation points forward in it)
  for (const b of seqP) {
    let bx = 0, by = 0;
    for (const a of seqP) {
      if (a === b) break;
      if (leftOf(a, b)) bx = Math.max(bx, x.get(a)! + byId.get(a)!.w);
      if (above(a, b)) by = Math.max(by, y.get(a)! + byId.get(a)!.h);
    }
    x.set(b, bx);
    y.set(b, by);
  }
  let W = 0, H = 0;
  for (const p of PARTS) {
    W = Math.max(W, x.get(p.id)! + p.w);
    H = Math.max(H, y.get(p.id)! + p.h);
  }
  return { x, y, W, H, leftOf, above };
}

function shuffled(rng: () => number, a: string[]): string[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export default function SequencePairDemo() {
  const ids = PARTS.map((p) => p.id);
  // the two orders read off the packing in the step-line figure above
  const [seqP, setSeqP] = useState<string[]>(["A", "B", "C", "E", "D"]);
  const [seqN, setSeqN] = useState<string[]>(["C", "A", "B", "D", "E"]);
  const [pick, setPick] = useState<{ row: 0 | 1; id: string } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [seed, setSeed] = useState(1);

  const { x, y, W, H, leftOf, above } = pack(seqP, seqN);
  const byId = new Map(PARTS.map((p) => [p.id, p]));

  const clickChip = (row: 0 | 1, id: string) => {
    if (!pick || pick.row !== row) { setPick({ row, id }); return; }
    if (pick.id === id) { setPick(null); return; }
    const seq = row === 0 ? [...seqP] : [...seqN];
    const i = seq.indexOf(pick.id), j = seq.indexOf(id);
    [seq[i], seq[j]] = [seq[j], seq[i]];
    if (row === 0) setSeqP(seq); else setSeqN(seq);
    setPick(null);
  };
  const shuffle = () => {
    let s = seed * 2654435761 + 1;
    const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    setSeqP(shuffled(rng, ids));
    setSeqN(shuffled(rng, ids));
    setSeed(seed + 1);
    setPick(null);
  };

  const relations = hover
    ? PARTS.filter((p) => p.id !== hover).map((p) => {
        if (leftOf(hover, p.id)) return `${hover} is left of ${p.id}`;
        if (leftOf(p.id, hover)) return `${hover} is right of ${p.id}`;
        if (above(hover, p.id)) return `${hover} is above ${p.id}`;
        return `${hover} is below ${p.id}`;
      })
    : [];

  const Chip = ({ row, id }: { row: 0 | 1; id: string }) => {
    const p = byId.get(id)!;
    const picked = pick?.row === row && pick.id === id;
    return (
      <button
        onClick={() => { trackDemo("sequence-pair", "chip"); clickChip(row, id); }}
        onMouseEnter={() => setHover(id)}
        onMouseLeave={() => setHover(null)}
        className={`w-8 h-8 rounded text-white text-sm font-mono border-2 transition-transform ${picked ? "scale-110 border-neutral-900 dark:border-white" : "border-transparent"} ${hover === id ? "ring-2 ring-offset-1 ring-neutral-400" : ""}`}
        style={{ background: p.color }}
        title="Click two components in the same row to swap them"
      >
        {id}
      </button>
    );
  };

  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100";
  const PW = Math.max(W, 8) * CELL, PH = Math.max(H, 6) * CELL;

  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="space-y-3 text-xs text-neutral-700 dark:text-neutral-300">
          <div className="flex items-center gap-2">
            <span className="w-24 font-mono">first order</span>
            <div className="flex gap-1">{seqP.map((id) => <Chip key={id} row={0} id={id} />)}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 font-mono">second order</span>
            <div className="flex gap-1">{seqN.map((id) => <Chip key={id} row={1} id={id} />)}</div>
          </div>
          <div className="flex gap-2">
            <button className={btn} onClick={() => { trackDemo("sequence-pair", "shuffle"); shuffle(); }}>Shuffle both</button>
            <button className={btn} onClick={() => { trackDemo("sequence-pair", "reset"); setSeqP(["A", "B", "C", "E", "D"]); setSeqN(["C", "A", "B", "D", "E"]); setPick(null); }}>Reset</button>
          </div>
          <p className="text-neutral-500 dark:text-neutral-400">Click two components in one row to swap them. Hover a component to read its relations.</p>
          <div className="font-mono min-h-[5.5rem]">
            {hover ? relations.map((r) => <div key={r}>{r}</div>) : <div className="text-neutral-400">board {W} × {H} = {W * H} cells</div>}
          </div>
        </div>
        <svg width={PW} height={PH} viewBox={`0 0 ${PW} ${PH}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
          {Array.from({ length: Math.round(PW / CELL) + 1 }, (_, i) => (
            <line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={PH} stroke="currentColor" strokeOpacity={0.08} />
          ))}
          {Array.from({ length: Math.round(PH / CELL) + 1 }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={i * CELL} x2={PW} y2={i * CELL} stroke="currentColor" strokeOpacity={0.08} />
          ))}
          <rect x={0} y={0} width={W * CELL} height={H * CELL} fill="none" stroke="#113768" strokeOpacity={0.5} strokeDasharray="4 3" />
          {PARTS.map((p) => (
            <g key={p.id} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}>
              <rect x={x.get(p.id)! * CELL + 1} y={y.get(p.id)! * CELL + 1} width={p.w * CELL - 2} height={p.h * CELL - 2} rx={3} fill={p.color} fillOpacity={hover && hover !== p.id ? 0.35 : 0.85} />
              <text x={(x.get(p.id)! + p.w / 2) * CELL} y={(y.get(p.id)! + p.h / 2) * CELL + 4} textAnchor="middle" fontSize={12} fill="#fff" fontFamily="ui-monospace, monospace">{p.id}</text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        Two orderings of five components and the packing they describe. A component that comes first in both orders sits to the left,
        a component that comes first in the first order but later in the second sits above. Every possible pair of orders is a
        valid, overlap-free packing, and every packing that matters has a pair of orders.
      </figcaption>
    </figure>
  );
}
