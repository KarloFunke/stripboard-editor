"use client";

import { useEffect, useRef, useState } from "react";
import { BLOCKS, LINKS, WIRE_WEIGHT, mulberry32 } from "./AnnealDemo";

// ── The eight blocks of the first demo, annealed as a sequence pair ──
// Same blocks, same links, same score (bounding box area + 1.5 × wire) and
// the same cooling schedule as AnnealDemo. The state is a pair of orders
// and the moves are two of the three from Murata et al. 1995: swap two
// names in the first order, or swap two names in both orders. Every move
// decodes to a board.

const N = BLOCKS.length;
const CELL = 22;
const VIEW_W = 14; // drawn at the size of the first demo's grid, zooming out when a packing is larger
const VIEW_H = 10;
const T0 = 6;
const T1 = 0.5;
const P_ONE = 0.5; // swap in the first order only; otherwise in both

type Pos = { x: number; y: number };
interface State { p: number[]; n: number[] }

// longest path in first-order sequence: a before b in both orders → a left of b, else a above b
function pack(st: State): { pos: Pos[]; W: number; H: number } {
  const posN = new Array<number>(N);
  st.n.forEach((id, i) => (posN[id] = i));
  const x = new Array<number>(N).fill(0), y = new Array<number>(N).fill(0);
  for (let bi = 0; bi < N; bi++) {
    const b = st.p[bi];
    let bx = 0, by = 0;
    for (let ai = 0; ai < bi; ai++) {
      const a = st.p[ai];
      if (posN[a] < posN[b]) bx = Math.max(bx, x[a] + BLOCKS[a].w);
      else by = Math.max(by, y[a] + BLOCKS[a].h);
    }
    x[b] = bx;
    y[b] = by;
  }
  let W = 0, H = 0;
  for (let i = 0; i < N; i++) { W = Math.max(W, x[i] + BLOCKS[i].w); H = Math.max(H, y[i] + BLOCKS[i].h); }
  return { pos: x.map((xx, i) => ({ x: xx, y: y[i] })), W, H };
}

function energyOf(st: State): { area: number; wire: number; E: number } {
  const { pos, W, H } = pack(st);
  const area = W * H;
  let wire = 0;
  for (const [a, b] of LINKS) {
    wire += Math.abs(pos[a].x + BLOCKS[a].w / 2 - pos[b].x - BLOCKS[b].w / 2) + Math.abs(pos[a].y + BLOCKS[a].h / 2 - pos[b].y - BLOCKS[b].h / 2);
  }
  return { area, wire, E: area + WIRE_WEIGHT * wire };
}

function shuffled(rng: () => number, a: number[]): number[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function swapIn(seq: number[], i: number, j: number): number[] {
  const s = [...seq];
  const a = s.indexOf(i), b = s.indexOf(j);
  [s[a], s[b]] = [s[b], s[a]];
  return s;
}

type MoveKind = "better" | "worse-kept" | "worse-rejected";
type MoveType = "one" | "both";

interface Sim {
  rng: () => number;
  st: State;
  E: number;
  best: number;
  bestSt: State;
  step: number;
  steps: number;
  trace: { E: number; best: number; T: number }[];
  lastMove: MoveKind | null;
  lastType: MoveType | null;
  lastBlocks: number[];
  keptWorse: number;
  recent: MoveKind[];
  done: boolean;
}

function makeSim(seed: number, steps: number): Sim {
  const rng = mulberry32(seed * 7919 + 17);
  const st: State = { p: shuffled(rng, [...Array(N).keys()]), n: shuffled(rng, [...Array(N).keys()]) };
  const E = energyOf(st).E;
  return {
    rng, st, E, best: E, bestSt: st, step: 0, steps,
    trace: [{ E, best: E, T: T0 }], lastMove: null, lastType: null, lastBlocks: [], keptWorse: 0, recent: [], done: false,
  };
}

function tempAt(sim: Sim): number {
  return T0 * Math.pow(T1 / T0, sim.step / sim.steps);
}

function tick(sim: Sim) {
  if (sim.done) return;
  const { rng, st } = sim;
  const T = tempAt(sim);
  const r = rng();
  const i = Math.floor(rng() * N);
  let j = Math.floor(rng() * N);
  if (j === i) j = (j + 1) % N;
  const type: MoveType = r < P_ONE ? "one" : "both";
  const next: State = type === "one" ? { p: swapIn(st.p, i, j), n: st.n } : { p: swapIn(st.p, i, j), n: swapIn(st.n, i, j) };
  const E2 = energyOf(next).E;
  const dE = E2 - sim.E;
  let kind: MoveKind;
  if (dE <= 0) {
    kind = "better";
    sim.st = next;
    sim.E = E2;
  } else if (rng() < Math.exp(-dE / T)) {
    kind = "worse-kept";
    sim.st = next;
    sim.E = E2;
    sim.keptWorse++;
  } else kind = "worse-rejected";
  if (sim.E < sim.best) {
    sim.best = sim.E;
    sim.bestSt = sim.st;
  }
  sim.lastMove = kind;
  sim.lastType = type;
  sim.lastBlocks = [i, j];
  sim.recent.push(kind);
  if (sim.recent.length > 200) sim.recent.shift();
  sim.step++;
  const every = Math.max(1, Math.floor(sim.steps / 300));
  if (sim.step % every === 0) sim.trace.push({ E: sim.E, best: sim.best, T });
  if (sim.step >= sim.steps) {
    sim.done = true;
    sim.st = sim.bestSt;
    sim.E = sim.best;
  }
}

export default function SeqPairAnnealDemo({
  seed = 1,
  steps: initialSteps = 3000,
  caption,
}: {
  seed?: number;
  steps?: number;
  caption?: string;
}) {
  const [steps, setSteps] = useState(initialSteps);
  const [speed, setSpeed] = useState(3);
  const [seedN, setSeedN] = useState(seed);
  const simRef = useRef<Sim | null>(null);
  if (!simRef.current) simRef.current = makeSim(seed, initialSteps);
  const [running, setRunning] = useState(false);
  const [, setFrame] = useState(0);

  const reset = (newSeed = seedN, n = steps) => {
    simRef.current = makeSim(newSeed, n);
    setRunning(false);
    setFrame((f) => f + 1);
  };

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = () => {
      const sim = simRef.current!;
      for (let k = 0; k < speed && !sim.done; k++) tick(sim);
      setFrame((f) => f + 1);
      if (sim.done) { setRunning(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed]);

  const sim = simRef.current!;
  const { pos, W: bw, H: bh } = pack(sim.st);
  const { area, wire } = energyOf(sim.st);
  const T = tempAt(sim);
  const recentWorse = sim.recent.filter((k) => k === "worse-kept").length;
  const recentWorseAll = sim.recent.filter((k) => k === "worse-kept" || k === "worse-rejected").length;

  // drawn at the first demo's size; a packing larger than that grid zooms the view out
  const VW = Math.max(VIEW_W, bw), VH = Math.max(VIEW_H, bh);
  const W = VIEW_W * CELL, H = VIEW_H * CELL;
  const scale = Math.min(W / (VW * CELL), H / (VH * CELL));
  const centers = pos.map((p, i) => ({ x: (p.x + BLOCKS[i].w / 2) * CELL, y: (p.y + BLOCKS[i].h / 2) * CELL }));
  const flashColor = sim.lastMove === "better" ? "#16a34a" : sim.lastMove === "worse-kept" ? "#f59e0b" : sim.lastMove === "worse-rejected" ? "#dc2626" : "#9ca3af";
  const flashed = new Set(sim.lastMove ? sim.lastBlocks : []);

  // energy trace
  const TW = 320, TH = 130, PAD = 4;
  const tr = sim.trace;
  const eMax = Math.max(...tr.map((t) => t.E), 1);
  const eMin = Math.min(...tr.map((t) => t.best));
  const xAt = (i: number) => PAD + (i / 300) * (TW - 2 * PAD);
  const yAt = (e: number) => PAD + (1 - (e - eMin * 0.9) / (eMax - eMin * 0.9)) * (TH - 2 * PAD);
  const pathOf = (key: "E" | "best") => tr.map((t, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(t[key]).toFixed(1)}`).join(" ");
  const tPath = tr.map((t, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${(PAD + (1 - Math.log(t.T / T1) / Math.log(T0 / T1)) * (TH - 2 * PAD)).toFixed(1)}`).join(" ");

  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";
  const sel = "px-1.5 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100";

  const OrderRow = ({ label, seq }: { label: string; seq: number[] }) => (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 font-mono text-neutral-600 dark:text-neutral-300">{label}</span>
      <div className="flex gap-1">
        {seq.map((id) => (
          <span key={id} className="w-6 h-6 rounded text-white text-xs font-mono flex items-center justify-center border-2"
            style={{ background: BLOCKS[id].color, borderColor: flashed.has(id) ? flashColor : "transparent" }}>
            {BLOCKS[id].label}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={btn} onClick={() => setRunning((r) => !r)} disabled={sim.done}>{running ? "Pause" : sim.step === 0 ? "Play" : "Continue"}</button>
        <button className={btn} onClick={() => { for (let k = 0; k < 100 && !sim.done; k++) tick(sim); setFrame((f) => f + 1); }} disabled={sim.done}>+100 steps</button>
        <button className={btn} onClick={() => reset()}>Restart</button>
        <button className={btn} onClick={() => { const s = seedN + 1; setSeedN(s); reset(s); }}>New start</button>
        <select className={sel} value={steps} onChange={(e) => { const n = Number(e.target.value); setSteps(n); reset(seedN, n); }} title="How many steps the run takes; the annealer cools over this many">
          <option value={750}>750 steps</option>
          <option value={1500}>1,500 steps</option>
          <option value={3000}>3,000 steps</option>
          <option value={12000}>12,000 steps</option>
        </select>
        <select className={sel} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Steps per animation frame">
          <option value={1}>slow</option>
          <option value={3}>normal</option>
          <option value={25}>fast</option>
          <option value={200}>instant</option>
        </select>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <div className="space-y-2">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
            <g transform={`scale(${scale.toFixed(4)})`}>
              {Array.from({ length: VW + 1 }, (_, i) => (
                <line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={VH * CELL} stroke="currentColor" strokeOpacity={0.08} />
              ))}
              {Array.from({ length: VH + 1 }, (_, i) => (
                <line key={`h${i}`} x1={0} y1={i * CELL} x2={VW * CELL} y2={i * CELL} stroke="currentColor" strokeOpacity={0.08} />
              ))}
              <rect x={0} y={0} width={bw * CELL} height={bh * CELL} fill="none" stroke="#113768" strokeOpacity={0.5} strokeDasharray="4 3" />
              {LINKS.map(([a, b], i) => (
                <line key={i} x1={centers[a].x} y1={centers[a].y} x2={centers[b].x} y2={centers[b].y} stroke="#171717" strokeWidth={2.2} strokeOpacity={0.8} className="dark:[stroke:#e5e5e5]" />
              ))}
              {pos.map((p, i) => (
                <g key={i}>
                  <rect x={p.x * CELL + 1} y={p.y * CELL + 1} width={BLOCKS[i].w * CELL - 2} height={BLOCKS[i].h * CELL - 2} rx={3} fill={BLOCKS[i].color} fillOpacity={0.85}
                    stroke={flashed.has(i) ? flashColor : "none"} strokeWidth={3} />
                  <text x={centers[i].x} y={centers[i].y + 4} textAnchor="middle" fontSize={12} fill="#fff" fontFamily="ui-monospace, monospace">{BLOCKS[i].label}</text>
                </g>
              ))}
            </g>
          </svg>
          <OrderRow label="first order" seq={sim.st.p} />
          <OrderRow label="second order" seq={sim.st.n} />
        </div>
        <div className="flex-1 min-w-0 text-xs text-neutral-700 dark:text-neutral-300 space-y-2">
          <svg width={TW} height={TH} viewBox={`0 0 ${TW} ${TH}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
            <path d={tPath} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" />
            <path d={pathOf("E")} fill="none" stroke="#113768" strokeWidth={1.2} className="dark:[stroke:#5b9bd5]" />
            <path d={pathOf("best")} fill="none" stroke="#16a34a" strokeWidth={1.5} />
          </svg>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono whitespace-nowrap min-h-[9.75rem] content-start">
            <span>step</span><span>{sim.step.toLocaleString()} / {sim.steps.toLocaleString()}</span>
            <span>score</span><span>{sim.E.toFixed(1)}</span>
            <span></span><span className="text-neutral-400">{area} area, {wire.toFixed(0)} wire</span>
            <span className="text-green-700 dark:text-green-400">best so far</span><span className="text-green-700 dark:text-green-400">{sim.best.toFixed(1)}</span>
            <span className="text-amber-600">temperature</span><span className="text-amber-600">{T.toFixed(2)}</span>
            <span>worse moves kept</span><span>{sim.keptWorse.toLocaleString()}{recentWorseAll > 0 && <span className="text-neutral-400"> (last 200: {Math.round((100 * recentWorse) / recentWorseAll)}%)</span>}</span>
            <span>last move</span><span>{sim.lastMove === null ? "none yet" : sim.lastType === "one" ? "swap in first order" : "swap in both orders"}</span>
            <span></span><span style={{ color: flashColor }}>{sim.lastMove === "better" ? "better, kept" : sim.lastMove === "worse-kept" ? "worse, kept" : sim.lastMove === "worse-rejected" ? "worse, rejected" : ""}</span>
          </div>
          <p className="text-neutral-500 dark:text-neutral-400 min-h-[1.25rem]">{sim.done ? "Finished. Showing the best board of the run." : ""}</p>
        </div>
      </div>
      {caption && <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
