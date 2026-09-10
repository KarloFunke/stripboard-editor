"use client";

import { useState } from "react";
import { dipNotch } from "@/components/stripboard/componentGlyphs";

// ── From description to board, one layer at a time ──
// A hand-made example drawn the way the editor draws a board: copper strips,
// holes, dashed component bodies with the label above, net-coloured pins, red X
// cut marks and link wires. A resistor standing upright, a 6-pin IC, a
// resistor lying flat and a 2-pin connector.

const ROWS = 5, COLS = 8;
const SP = 30; // hole spacing, as in the editor
const HOLE_R = 4.5, STRIP_H = 6, PAD = SP * 0.4;
const LEFT = 56, TOP = 46; // room for the row and column labels
const W = LEFT + (COLS - 1) * SP + 20, H = TOP + (ROWS - 1) * SP + 20;
const COPPER = "#D4A853", CONFLICT = "#dc2626";
// colours from the editor's automatic net palette
const NET_COLORS: Record<string, string> = { A: "#22c55e", B: "#3b82f6", C: "#8b5cf6", D: "#ec4899", E: "#f97316" };

interface Pin { r: number; c: number; net: string; id: string }
interface Part { id: string; dip?: boolean; body: { r1: number; c1: number; r2: number; c2: number }; pins: Pin[] }
const PARTS: Part[] = [
  { id: "R1", body: { r1: 0, c1: 0, r2: 2, c2: 0 }, pins: [{ r: 0, c: 0, net: "A", id: "1" }, { r: 2, c: 0, net: "B", id: "2" }] },
  { id: "U1", dip: true, body: { r1: 0, c1: 2, r2: 2, c2: 5 }, pins: [{ r: 0, c: 2, net: "A", id: "1" }, { r: 1, c: 2, net: "C", id: "2" }, { r: 2, c: 2, net: "B", id: "3" }, { r: 2, c: 5, net: "B", id: "4" }, { r: 1, c: 5, net: "D", id: "5" }, { r: 0, c: 5, net: "E", id: "6" }] },
  { id: "R2", body: { r1: 4, c1: 2, r2: 4, c2: 5 }, pins: [{ r: 4, c: 2, net: "C", id: "1" }, { r: 4, c: 5, net: "D", id: "2" }] },
  { id: "J1", body: { r1: 0, c1: 7, r2: 1, c2: 7 }, pins: [{ r: 0, c: 7, net: "E", id: "1" }, { r: 1, c: 7, net: "D", id: "2" }] },
];
const CUTS = [{ r: 0, c: 3 }, { r: 1, c: 3 }, { r: 4, c: 3 }]; // drilled-out holes
const WIRES = [{ net: "C", r1: 1, r2: 4, c: 1 }, { net: "D", r1: 1, r2: 4, c: 6 }];

const STEPS = [
  {
    title: "1. The description",
    text: "Two orders of the four components say who is left of whom and who is above whom; R1 stands upright and R2 lies flat, each spanning a chosen number of holes; pins that share a net are asked to share a strip where they can. Nothing here is a coordinate.",
  },
  {
    title: "2. Positions",
    text: "Solving the spacing constraints puts every component as far up and left as its neighbours and clearances allow, so R1 lands in the top left corner. U1 sits right of R1 with one free column between them, J1 right of U1, R2 below U1 with a free row between.",
  },
  {
    title: "3. Strips and pins",
    text: "Each row is a copper strip, and the grid is read row by row. On row 1 the strip carries pin A of R1 and U1 on the left but pin E of U1 and J1 on the right, so two nets meet on one strip; the editor would show that as a red strip. Row 4 carries no pins at all: it is free to serve as a bus row.",
  },
  {
    title: "4. Cuts",
    text: "Wherever two nets meet on a strip, the strip is cut between them. Here a hole is drilled out under the IC body on rows 1 and 2, and between the two resistor legs on row 5. Each strip falls into segments, each carrying one net.",
  },
  {
    title: "5. Link wires",
    text: "Nets that are split over several segments are joined by vertical link wires between two free holes. Net C needs one from row 2 down to row 5 in column 2, net D one in column 7. Both run straight, cross no component, and end on holes that were still free.",
  },
  {
    title: "6. The score",
    text: "Board 5 × 8 = 40 cells, 2 link wires of length 3, 3 cuts, connector J1 on the right edge, no slanted or crossing wire, every pin reachable. That number is what the annealer compares between two descriptions.",
  },
];

const cx = (c: number) => LEFT + c * SP;
const cy = (r: number) => TOP + r * SP;

export default function DecodeSteps() {
  const [step, setStep] = useState(0);
  const showBoard = step >= 1, showNets = step >= 2, showCuts = step >= 3, showWires = step >= 4;

  // strip segments per row, split at the drilled holes once cuts are shown
  const pinsByRow = new Map<number, Pin[]>();
  for (const p of PARTS) for (const pin of p.pins) { if (!pinsByRow.has(pin.r)) pinsByRow.set(pin.r, []); pinsByRow.get(pin.r)!.push(pin); }
  const segments: { r: number; c1: number; c2: number; nets: string[] }[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cuts = showCuts ? CUTS.filter((k) => k.r === r).map((k) => k.c).sort((a, b) => a - b) : [];
    let c1 = 0;
    for (const cutC of [...cuts, COLS]) {
      const c2 = cutC === COLS ? COLS - 1 : cutC - 1;
      const nets = [...new Set((pinsByRow.get(r) ?? []).filter((p) => p.c >= c1 && p.c <= c2).map((p) => p.net))];
      if (c2 >= c1) segments.push({ r, c1, c2, nets });
      c1 = cutC + 1;
    }
  }
  const isCut = (r: number, c: number) => showCuts && CUTS.some((k) => k.r === r && k.c === c);

  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";

  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-col md:flex-row gap-4">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-white dark:bg-[#1e1e1e] border border-neutral-200 dark:border-neutral-700 font-sans">
          {!showBoard && (
            <g fontFamily="ui-monospace, monospace" fontSize={11} fill="var(--component-text)">
              <text x={16} y={34}>first order   R1  U1  R2  J1</text>
              <text x={16} y={54}>second order  R2  R1  U1  J1</text>
              <text x={16} y={84}>R1  upright, span 2</text>
              <text x={16} y={104}>R2  flat, span 3</text>
              <text x={16} y={134}>net B  both U1 pins on one strip</text>
              <text x={16} y={164} fill="var(--label-text)">no coordinates yet</text>
            </g>
          )}
          {showBoard && (
            <>
              {/* strips */}
              {segments.map((s, i) => {
                const color = !showNets ? COPPER : s.nets.length >= 2 ? CONFLICT : s.nets.length === 1 ? NET_COLORS[s.nets[0]] : COPPER;
                const leftX = s.c1 > 0 && isCut(s.r, s.c1 - 1) ? cx(s.c1 - 1) + HOLE_R + 1.5 : cx(s.c1) - SP * 0.4;
                const rightX = s.c2 < COLS - 1 && isCut(s.r, s.c2 + 1) ? cx(s.c2 + 1) - HOLE_R - 1.5 : cx(s.c2) + SP * 0.4;
                return <rect key={i} x={leftX} y={cy(s.r) - STRIP_H / 2} width={rightX - leftX} height={STRIP_H} rx={1} fill={color} opacity={showNets && s.nets.length >= 2 ? 0.8 : showNets && s.nets.length ? 0.5 : 0.4} />;
              })}
              {/* labels */}
              {Array.from({ length: ROWS }, (_, r) => <text key={`r${r}`} x={cx(0) - 30} y={cy(r) + 4} textAnchor="end" fontSize={11} fill="var(--label-text)">{r + 1}</text>)}
              {Array.from({ length: COLS }, (_, c) => <text key={`c${c}`} x={cx(c)} y={cy(0) - 28} textAnchor="middle" fontSize={11} fill="var(--label-text)">{c + 1}</text>)}
              {/* holes */}
              {Array.from({ length: ROWS * COLS }, (_, i) => {
                const r = Math.floor(i / COLS), c = i % COLS;
                return <circle key={i} cx={cx(c)} cy={cy(r)} r={HOLE_R} fill="var(--hole-fill)" stroke="var(--hole-stroke)" strokeWidth={0.5} />;
              })}
              {/* components */}
              {PARTS.map((p) => {
                const x0 = cx(p.body.c1) - PAD, y0 = cy(p.body.r1) - PAD;
                const bw = (p.body.c2 - p.body.c1) * SP + 2 * PAD, bh = (p.body.r2 - p.body.r1) * SP + 2 * PAD;
                const center = { x: cx((p.body.c1 + p.body.c2) / 2), y: cy((p.body.r1 + p.body.r2) / 2) };
                return (
                  <g key={p.id}>
                    <rect x={x0} y={y0} width={bw} height={bh} rx={3} fill="var(--component-fill)" stroke="var(--component-stroke)" strokeWidth={1} strokeDasharray="4 3" />
                    {p.dip && <path d={dipNotch(p.pins.map((pin) => ({ x: cx(pin.c), y: cy(pin.r), id: pin.id })), center, PAD)} fill="none" stroke="var(--component-stroke)" strokeWidth={1} />}
                    <text x={center.x} y={y0 - 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--component-text)">{p.id}</text>
                    {p.pins.map((pin) => (
                      <g key={pin.id}>
                        <circle cx={cx(pin.c)} cy={cy(pin.r)} r={5} fill={showNets ? NET_COLORS[pin.net] : "var(--hole-fill)"} stroke={showNets ? "var(--hole-fill)" : "var(--hole-stroke)"} strokeWidth={showNets ? 1.5 : 0.5} />
                        <text x={cx(pin.c)} y={cy(pin.r) + 10} textAnchor="middle" fontSize={6} fill="var(--component-subtext)">{showNets ? pin.net : pin.id}</text>
                      </g>
                    ))}
                  </g>
                );
              })}
              {/* cut marks */}
              {showCuts && CUTS.map((k, i) => (
                <g key={i} stroke="var(--cut-stroke)" strokeWidth={2} strokeLinecap="round">
                  <line x1={cx(k.c) - 4} y1={cy(k.r) - 4} x2={cx(k.c) + 4} y2={cy(k.r) + 4} />
                  <line x1={cx(k.c) + 4} y1={cy(k.r) - 4} x2={cx(k.c) - 4} y2={cy(k.r) + 4} />
                </g>
              ))}
              {/* link wires */}
              {showWires && WIRES.map((w, i) => (
                <g key={i}>
                  <line x1={cx(w.c)} y1={cy(w.r1)} x2={cx(w.c)} y2={cy(w.r2)} stroke={NET_COLORS[w.net]} strokeWidth={2} strokeLinecap="round" opacity={0.8} />
                  <circle cx={cx(w.c)} cy={cy(w.r1)} r={4.5} fill={NET_COLORS[w.net]} />
                  <circle cx={cx(w.c)} cy={cy(w.r2)} r={4.5} fill={NET_COLORS[w.net]} />
                </g>
              ))}
            </>
          )}
        </svg>
        <div className="flex-1 min-w-0 text-xs text-neutral-700 dark:text-neutral-300">
          <div className="flex items-center gap-2 mb-2">
            <button className={btn} onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>&larr;</button>
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">{STEPS[step].title}</span>
            <button className={btn} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} disabled={step === STEPS.length - 1}>&rarr;</button>
          </div>
          <p className="leading-relaxed">{STEPS[step].text}</p>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
            {Object.entries(NET_COLORS).map(([n, c]) => (
              <span key={n} className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: c }} />net {n}</span>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        Decoding a description into a board, drawn as the editor would draw it. Step through with the arrows. Everything
        from step 2 on follows mechanically from step 1; the annealer only ever edits step 1 and reads off step 6.
      </figcaption>
    </figure>
  );
}
