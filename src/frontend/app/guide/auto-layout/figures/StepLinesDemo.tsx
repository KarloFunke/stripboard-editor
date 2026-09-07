"use client";

import { useEffect, useMemo, useState } from "react";

// ── How a packing is read into its two orders (Murata's step-lines) ──
// Positive step-line of a part: from its lower-left corner go down, sliding
// left along the top of any part in the way, to the bottom of the board;
// from its upper-right corner go up, sliding right along the bottom of any
// part in the way, to the top. These lines never cross, and reading them
// from left to right gives the first order. The negative step-line does
// the mirror image (upper-left corner up and left, lower-right corner down
// and right) and gives the second order.

interface Mod { id: string; x1: number; x2: number; y1: number; y2: number; color: string }
// the same five parts as the packing figure below; y grows upward in these
// coordinates, and every edge coordinate is distinct
const MODS: Mod[] = [
  { id: "A", x1: 0.5, x2: 3.5, y1: 5.5, y2: 7.5, color: "#b45309" },
  { id: "B", x1: 4, x2: 6, y1: 4, y2: 7, color: "#0f766e" },
  { id: "C", x1: 1, x2: 5, y1: 2.5, y2: 3.5, color: "#1d4ed8" },
  { id: "D", x1: 6.5, x2: 7.5, y1: 1, y2: 3, color: "#7e22ce" },
  { id: "E", x1: 7, x2: 9, y1: 4.5, y2: 6.5, color: "#be123c" },
];
const CHIP = { x1: 0, x2: 10, y1: 0, y2: 8.5 };
const S = 34;

type Pt = [number, number];

// walk vertically from (x, y); when a part blocks, slide along its edge
function walk(x: number, y: number, dir: "up" | "down", slide: "left" | "right", self: string): Pt[] {
  const pts: Pt[] = [];
  for (let guard = 0; guard < 50; guard++) {
    let blocker: Mod | null = null;
    for (const m of MODS) {
      if (m.id === self) continue;
      const inX = slide === "right" ? m.x1 <= x && x < m.x2 : m.x1 < x && x <= m.x2;
      if (!inX) continue;
      if (dir === "up" && m.y1 >= y && (!blocker || m.y1 < blocker.y1)) blocker = m;
      if (dir === "down" && m.y2 <= y && (!blocker || m.y2 > blocker.y2)) blocker = m;
    }
    if (!blocker) {
      pts.push([x, dir === "up" ? CHIP.y2 : CHIP.y1]);
      return pts;
    }
    const edgeY = dir === "up" ? blocker.y1 : blocker.y2;
    pts.push([x, edgeY]);
    x = slide === "right" ? blocker.x2 : blocker.x1;
    pts.push([x, edgeY]);
    y = edgeY;
  }
  return pts;
}

// the three pieces of a step-line, each starting at the part so the
// drawing grows outward from its corners: one half to the bottom, one half
// to the top, and the diagonal through the part
function stepPieces(m: Mod, sign: "pos" | "neg"): Pt[][] {
  if (sign === "pos") {
    const down = [[m.x1, m.y1] as Pt, ...walk(m.x1, m.y1, "down", "left", m.id)];
    const up = [[m.x2, m.y2] as Pt, ...walk(m.x2, m.y2, "up", "right", m.id)];
    return [down, up, [[m.x1, m.y1], [m.x2, m.y2]]];
  }
  const up = [[m.x1, m.y2] as Pt, ...walk(m.x1, m.y2, "up", "left", m.id)];
  const down = [[m.x2, m.y1] as Pt, ...walk(m.x2, m.y1, "down", "right", m.id)];
  return [up, down, [[m.x1, m.y2], [m.x2, m.y1]]];
}

// the whole line as one polyline from the bottom to the top of the board
function stepLine(m: Mod, sign: "pos" | "neg"): Pt[] {
  const [a, b] = stepPieces(m, sign);
  const bottomFirst = sign === "pos" ? a : b;
  const topPart = sign === "pos" ? b : a;
  return [...[...bottomFirst].reverse(), ...topPart];
}

// x of a step-line at height y (lines are monotone in y; y is chosen off
// every edge coordinate so it never lands on a horizontal segment)
function xAt(pts: Pt[], y: number): number {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (y < lo || y > hi || lo === hi) continue;
    return x1 === x2 ? x1 : x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
  }
  return pts[pts.length - 1][0];
}

function orderOf(sign: "pos" | "neg"): string[] {
  // lines never cross, so wherever two of them differ the same one is
  // left; they may touch, so compare at every sampled height and take the
  // first difference from the top
  const lines = new Map(MODS.map((m) => [m.id, stepLine(m, sign)]));
  const ys: number[] = [];
  for (let y = CHIP.y2 - 0.25; y > CHIP.y1; y -= 0.5) ys.push(y);
  return [...MODS].map((m) => m.id).sort((a, b) => {
    const la = lines.get(a)!, lb = lines.get(b)!;
    for (const y of ys) {
      const d = xAt(la, y) - xAt(lb, y);
      if (Math.abs(d) > 1e-9) return d;
    }
    return 0;
  });
}

export default function StepLinesDemo() {
  const [sign, setSign] = useState<"pos" | "neg">("pos");
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const order = useMemo(() => orderOf(sign), [sign]);
  const orderPos = useMemo(() => orderOf("pos"), []);
  const orderNeg = useMemo(() => orderOf("neg"), []);

  useEffect(() => {
    if (!playing) return;
    if (shown >= MODS.length) { setPlaying(false); return; }
    const t = setTimeout(() => setShown((n) => n + 1), 900);
    return () => clearTimeout(t);
  }, [playing, shown]);

  const W = (CHIP.x2 - CHIP.x1) * S, H = (CHIP.y2 - CHIP.y1) * S;
  const px = (x: number) => (x - CHIP.x1) * S;
  const py = (y: number) => (CHIP.y2 - y) * S;
  const byId = new Map(MODS.map((m) => [m.id, m]));
  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";
  const tab = (active: boolean) => `px-2 py-1 rounded text-xs border ${active ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15" : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`;
  const switchSign = (s: "pos" | "neg") => { setSign(s); setShown(0); setPlaying(false); };

  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={tab(sign === "pos")} onClick={() => switchSign("pos")}>first order</button>
        <button className={tab(sign === "neg")} onClick={() => switchSign("neg")}>second order</button>
        <span className="w-2" />
        <button className={btn} onClick={() => { if (shown >= MODS.length) setShown(0); setPlaying(true); }} disabled={playing}>Play</button>
        <button className={btn} onClick={() => setShown((n) => Math.min(MODS.length, n + 1))} disabled={playing || shown >= MODS.length}>Next line</button>
        <button className={btn} onClick={() => { setShown(0); setPlaying(false); }}>Clear</button>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
          <rect x={0} y={0} width={W} height={H} fill="none" stroke="currentColor" strokeOpacity={0.3} />
          {MODS.map((m) => (
            <g key={m.id} onMouseEnter={() => setHover(m.id)} onMouseLeave={() => setHover(null)}>
              <rect x={px(m.x1)} y={py(m.y2)} width={(m.x2 - m.x1) * S} height={(m.y2 - m.y1) * S} fill="#737373" fillOpacity={hover === m.id ? 0.75 : 0.45} />
              <text x={px((m.x1 + m.x2) / 2)} y={py((m.y1 + m.y2) / 2) + 5} textAnchor="middle" fontSize={14} fill="#fff" fontFamily="ui-monospace, monospace">{m.id}</text>
            </g>
          ))}
          {order.slice(0, shown).map((id, k) => {
            const m = byId.get(id)!;
            const dim = hover !== null && hover !== id;
            return stepPieces(m, sign).map((pts, j) => {
              const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(" ");
              return (
                <path key={`${id}${j}`} d={d} fill="none" stroke={m.color} strokeWidth={k === shown - 1 ? 3 : 2} strokeOpacity={dim ? 0.25 : 0.95} strokeLinejoin="round" strokeLinecap="round"
                  pathLength={1} strokeDasharray={1} strokeDashoffset={0}
                  style={k === shown - 1 ? { animation: "sp-draw 0.8s ease-out" } : undefined} />
              );
            });
          })}
          <style>{`@keyframes sp-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }`}</style>
        </svg>
        <div className="flex-1 min-w-0 text-xs text-neutral-700 dark:text-neutral-300 space-y-3">
          <p className="leading-relaxed">
            {sign === "pos"
              ? "Positive step-line: from the part's lower-left corner go down, sliding left along the top of anything in the way, until the bottom edge. From its upper-right corner go up, sliding right along the bottom of anything in the way, until the top edge. Join the two through the part."
              : "Negative step-line: from the part's upper-left corner go up, sliding left along the bottom of anything in the way, until the top edge. From its lower-right corner go down, sliding right along the top of anything in the way, until the bottom edge. Join the two through the part."}
          </p>
          <p className="leading-relaxed">The lines never cross, so they can be read from left to right. That reading is the {sign === "pos" ? "first" : "second"} order.</p>
          <div className="font-mono">
            <div className="flex items-center gap-1 flex-wrap min-h-[1.75rem]">
              <span className="w-24 text-neutral-500 dark:text-neutral-400">{sign === "pos" ? "first order" : "second order"}</span>
              {order.slice(0, shown).map((id) => (
                <span key={id} className="w-7 h-7 rounded text-white flex items-center justify-center" style={{ background: byId.get(id)!.color }}>{id}</span>
              ))}
              {shown < MODS.length && <span className="text-neutral-400">{shown === 0 ? "press Play" : "…"}</span>}
            </div>
          </div>
          <div className="font-mono text-neutral-500 dark:text-neutral-400 space-y-1 pt-2 border-t border-neutral-200 dark:border-neutral-700">
            <div>first order&nbsp;&nbsp;{orderPos.join(" ")}</div>
            <div>second order&nbsp;{orderNeg.join(" ")}</div>
            <div className="pt-1 text-neutral-600 dark:text-neutral-300 min-h-[5.5rem]">
              {hover
                ? MODS.filter((m) => m.id !== hover).map((m) => {
                    const a = hover, b = m.id;
                    const pa = orderPos.indexOf(a) < orderPos.indexOf(b), na = orderNeg.indexOf(a) < orderNeg.indexOf(b);
                    const rel = pa && na ? "left of" : !pa && !na ? "right of" : pa && !na ? "above" : "below";
                    return <div key={b}>{a} is {rel} {b}</div>;
                  })
                : "hover a part to read its relations off the two orders"}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        Reading a packing into its two orders, after Murata and colleagues, who introduced the idea for chip floorplans in
        1995. Every packing has exactly one pair of orders, and the pair contains everything about the packing that
        matters: for any two parts, first in both orders means left of, first in one and last in the other means above.
      </figcaption>
    </figure>
  );
}
