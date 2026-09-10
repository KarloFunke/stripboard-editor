"use client";

import { useEffect, useRef, useState } from "react";

// ── A miniature of the real problem, annealed live ──
// Eight blocks with a few connections on a small grid. Score = area of the
// bounding box + 1.5 × total connection length. Moves shift one block by
// one cell or swap two; anything overlapping or off the grid is not a
// board and is rejected outright. "greedy" keeps only improvements, "anneal" keeps a
// worse board with probability exp(-ΔE / T) while T cools geometrically.

const GRID_W = 14;
const GRID_H = 10;
const CELL = 22;
export const BLOCKS = [
  { w: 3, h: 2, color: "#b45309", label: "A" },
  { w: 2, h: 2, color: "#0f766e", label: "B" },
  { w: 2, h: 3, color: "#1d4ed8", label: "C" },
  { w: 3, h: 1, color: "#7e22ce", label: "D" },
  { w: 1, h: 3, color: "#be123c", label: "E" },
  { w: 2, h: 2, color: "#4d7c0f", label: "F" },
  { w: 1, h: 2, color: "#0e7490", label: "G" },
  { w: 2, h: 1, color: "#a16207", label: "H" },
];
export const LINKS: [number, number][] = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [3, 5], [1, 5], [6, 7], [2, 6], [0, 7], [4, 6]];
export const WIRE_WEIGHT = 1.5;

type Pos = { x: number; y: number };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fits(pos: Pos[], i: number, x: number, y: number): boolean {
  const b = BLOCKS[i];
  if (x < 0 || y < 0 || x + b.w > GRID_W || y + b.h > GRID_H) return false;
  for (let j = 0; j < pos.length; j++) {
    if (j === i) continue;
    const o = BLOCKS[j];
    const p = pos[j];
    if (x < p.x + o.w && p.x < x + b.w && y < p.y + o.h && p.y < y + b.h) return false;
  }
  return true;
}

function energyOf(pos: Pos[]): { area: number; wire: number; E: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pos.forEach((p, i) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + BLOCKS[i].w);
    maxY = Math.max(maxY, p.y + BLOCKS[i].h);
  });
  const area = (maxX - minX) * (maxY - minY);
  let wire = 0;
  for (const [a, b] of LINKS) {
    const ca = { x: pos[a].x + BLOCKS[a].w / 2, y: pos[a].y + BLOCKS[a].h / 2 };
    const cb = { x: pos[b].x + BLOCKS[b].w / 2, y: pos[b].y + BLOCKS[b].h / 2 };
    wire += Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
  }
  return { area, wire, E: area + WIRE_WEIGHT * wire };
}

function randomStart(rng: () => number): Pos[] {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const pos: Pos[] = [];
    let ok = true;
    for (let i = 0; i < BLOCKS.length; i++) {
      let placed = false;
      for (let t = 0; t < 200; t++) {
        const x = Math.floor(rng() * (GRID_W - BLOCKS[i].w + 1));
        const y = Math.floor(rng() * (GRID_H - BLOCKS[i].h + 1));
        pos.push({ x, y });
        if (fits(pos, i, x, y)) { placed = true; break; }
        pos.pop();
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return pos;
  }
  return BLOCKS.map((_, i) => ({ x: (i % 3) * 4, y: Math.floor(i / 3) * 4 }));
}

type MoveKind = "better" | "worse-kept" | "worse-rejected" | "invalid";

interface Sim {
  rng: () => number;
  pos: Pos[];
  E: number;
  best: number;
  bestPos: Pos[];
  step: number;
  steps: number;
  T0: number;
  T1: number;
  greedy: boolean;
  trace: { E: number; best: number; T: number }[];
  lastMove: MoveKind | null;
  lastBlock: number;
  keptWorse: number;
  recent: MoveKind[];
  done: boolean;
}

// schedule tuned on 40 random starts: within ~4% of a 60,000-step run
// after 3,000 steps (a colder finish or hotter start only wastes steps)
const T0 = 6;
const T1 = 0.5;
const P_SHIFT = 0.7;

function makeSim(seed: number, steps: number, greedy: boolean): Sim {
  const rng = mulberry32(seed * 7919 + 17);
  const pos = randomStart(rng);
  const E = energyOf(pos).E;
  return {
    rng, pos, E, best: E, bestPos: pos.map((p) => ({ ...p })), step: 0, steps, T0, T1, greedy,
    trace: [{ E, best: E, T: T0 }], lastMove: null, lastBlock: -1, keptWorse: 0, recent: [], done: false,
  };
}

function tempAt(sim: Sim): number {
  return sim.greedy ? 0 : sim.T0 * Math.pow(sim.T1 / sim.T0, sim.step / sim.steps);
}

function tick(sim: Sim) {
  if (sim.done) return;
  const { rng, pos } = sim;
  const T = tempAt(sim);
  let next: Pos[] | null = null;
  let block = -1;
  if (rng() < P_SHIFT) {
    const i = Math.floor(rng() * pos.length);
    const d = Math.floor(rng() * 4);
    const dx = [1, -1, 0, 0][d], dy = [0, 0, 1, -1][d];
    block = i;
    if (fits(pos, i, pos[i].x + dx, pos[i].y + dy)) {
      next = pos.map((p, k) => (k === i ? { x: p.x + dx, y: p.y + dy } : p));
    }
  } else {
    const i = Math.floor(rng() * pos.length);
    let j = Math.floor(rng() * pos.length);
    if (j === i) j = (j + 1) % pos.length;
    block = i;
    const trial = pos.map((p, k) => (k === i ? { ...pos[j] } : k === j ? { ...pos[i] } : p));
    if (fits(trial, i, trial[i].x, trial[i].y) && fits(trial, j, trial[j].x, trial[j].y)) next = trial;
  }
  let kind: MoveKind;
  if (!next) kind = "invalid";
  else {
    const E2 = energyOf(next).E;
    const dE = E2 - sim.E;
    if (dE <= 0) {
      kind = "better";
      sim.pos = next;
      sim.E = E2;
    } else if (!sim.greedy && rng() < Math.exp(-dE / T)) {
      kind = "worse-kept";
      sim.pos = next;
      sim.E = E2;
      sim.keptWorse++;
    } else kind = "worse-rejected";
    if (sim.E < sim.best) {
      sim.best = sim.E;
      sim.bestPos = sim.pos.map((p) => ({ ...p }));
    }
  }
  sim.lastMove = kind;
  sim.lastBlock = block;
  sim.recent.push(kind);
  if (sim.recent.length > 200) sim.recent.shift();
  sim.step++;
  const every = Math.max(1, Math.floor(sim.steps / 300));
  if (sim.step % every === 0) sim.trace.push({ E: sim.E, best: sim.best, T });
  if (sim.step >= sim.steps) {
    sim.done = true;
    sim.pos = sim.bestPos.map((p) => ({ ...p }));
    sim.E = sim.best;
  }
}

export default function AnnealDemo({
  mode,
  fixedMode = false,
  seed = 1,
  steps: initialSteps = 6000,
  caption,
}: {
  mode: "greedy" | "anneal";
  fixedMode?: boolean;
  seed?: number;
  steps?: number;
  caption?: string;
}) {
  const [greedy, setGreedy] = useState(mode === "greedy");
  const [steps, setSteps] = useState(initialSteps);
  const [speed, setSpeed] = useState(3);
  const [seedN, setSeedN] = useState(seed);
  const simRef = useRef<Sim | null>(null);
  if (!simRef.current) simRef.current = makeSim(seed, initialSteps, mode === "greedy");
  const [running, setRunning] = useState(false);
  const [, setFrame] = useState(0);

  const reset = (newSeed = seedN, g = greedy, n = steps) => {
    simRef.current = makeSim(newSeed, n, g);
    setRunning(false);
    setFrame((f) => f + 1);
  };

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let acc = 0;
    const loop = () => {
      const sim = simRef.current!;
      acc += speed;
      const n = Math.floor(acc);
      acc -= n;
      if (n > 0) {
        for (let k = 0; k < n && !sim.done; k++) tick(sim);
        setFrame((f) => f + 1);
      }
      if (sim.done) { setRunning(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed]);

  const sim = simRef.current!;
  const { area, wire } = energyOf(sim.pos);
  const T = tempAt(sim);
  const recentWorse = sim.recent.filter((k) => k === "worse-kept").length;
  const recentWorseAll = sim.recent.filter((k) => k === "worse-kept" || k === "worse-rejected").length;

  const W = GRID_W * CELL, H = GRID_H * CELL;
  const centers = sim.pos.map((p, i) => ({ x: (p.x + BLOCKS[i].w / 2) * CELL, y: (p.y + BLOCKS[i].h / 2) * CELL }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  sim.pos.forEach((p, i) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + BLOCKS[i].w); maxY = Math.max(maxY, p.y + BLOCKS[i].h);
  });
  const flashColor = sim.lastMove === "better" ? "#16a34a" : sim.lastMove === "worse-kept" ? "#f59e0b" : sim.lastMove === "worse-rejected" ? "#dc2626" : "#9ca3af";

  // energy trace
  const TW = 320, TH = 130, PAD = 4;
  const tr = sim.trace;
  const eMax = Math.max(...tr.map((t) => t.E), 1);
  const eMin = Math.min(...tr.map((t) => t.best));
  const xAt = (i: number) => PAD + (i / Math.max(1, Math.round(300))) * (TW - 2 * PAD);
  const yAt = (e: number) => PAD + (1 - (e - eMin * 0.9) / (eMax - eMin * 0.9)) * (TH - 2 * PAD);
  const pathOf = (key: "E" | "best") => tr.map((t, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(t[key]).toFixed(1)}`).join(" ");
  const tPath = sim.greedy ? "" : tr.map((t, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${(PAD + (1 - Math.log(t.T / T1) / Math.log(T0 / T1)) * (TH - 2 * PAD)).toFixed(1)}`).join(" ");

  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";
  const sel = "px-1.5 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100";

  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={btn} onClick={() => setRunning((r) => !r)} disabled={sim.done}>{running ? "Pause" : sim.step === 0 ? "Play" : "Continue"}</button>
        <button className={btn} onClick={() => { tick(sim); setFrame((f) => f + 1); }} disabled={sim.done}>+1 step</button>
        <button className={btn} onClick={() => { for (let k = 0; k < 100 && !sim.done; k++) tick(sim); setFrame((f) => f + 1); }} disabled={sim.done}>+100 steps</button>
        <button className={btn} onClick={() => reset()}>Restart</button>
        <button className={btn} onClick={() => { const s = seedN + 1; setSeedN(s); reset(s); }}>New start</button>
        {!fixedMode && (
          <select className={sel} value={greedy ? "greedy" : "anneal"} onChange={(e) => { const g = e.target.value === "greedy"; setGreedy(g); reset(seedN, g); }}>
            <option value="anneal">annealing</option>
            <option value="greedy">only improvements</option>
          </select>
        )}
        <select className={sel} value={steps} onChange={(e) => { const n = Number(e.target.value); setSteps(n); reset(seedN, greedy, n); }} title="How many steps the run takes; the annealer cools over this many">
          <option value={750}>750 steps</option>
          <option value={1500}>1,500 steps</option>
          <option value={3000}>3,000 steps</option>
          <option value={12000}>12,000 steps</option>
        </select>
        <select className={sel} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Steps per animation frame">
          <option value={0.25}>slow</option>
          <option value={3}>normal</option>
          <option value={25}>fast</option>
          <option value={200}>instant</option>
        </select>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
          {Array.from({ length: GRID_W + 1 }, (_, i) => (
            <line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={H} stroke="currentColor" strokeOpacity={0.08} />
          ))}
          {Array.from({ length: GRID_H + 1 }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={i * CELL} x2={W} y2={i * CELL} stroke="currentColor" strokeOpacity={0.08} />
          ))}
          <rect x={minX * CELL} y={minY * CELL} width={(maxX - minX) * CELL} height={(maxY - minY) * CELL} fill="none" stroke="#113768" strokeOpacity={0.5} strokeDasharray="4 3" />
          {LINKS.map(([a, b], i) => (
            <line key={i} x1={centers[a].x} y1={centers[a].y} x2={centers[b].x} y2={centers[b].y} stroke="#171717" strokeWidth={2.2} strokeOpacity={0.8} className="dark:[stroke:#e5e5e5]" />
          ))}
          {sim.pos.map((p, i) => (
            <g key={i}>
              <rect x={p.x * CELL + 1} y={p.y * CELL + 1} width={BLOCKS[i].w * CELL - 2} height={BLOCKS[i].h * CELL - 2} rx={3} fill={BLOCKS[i].color} fillOpacity={0.85}
                stroke={i === sim.lastBlock && sim.lastMove ? flashColor : "none"} strokeWidth={3} />
              <text x={centers[i].x} y={centers[i].y + 4} textAnchor="middle" fontSize={12} fill="#fff" fontFamily="ui-monospace, monospace">{BLOCKS[i].label}</text>
            </g>
          ))}
        </svg>
        <div className="flex-1 min-w-0 text-xs text-neutral-700 dark:text-neutral-300 space-y-2">
          <svg width={TW} height={TH} viewBox={`0 0 ${TW} ${TH}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
            {tPath && <path d={tPath} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" />}
            <path d={pathOf("E")} fill="none" stroke="#113768" strokeWidth={1.2} className="dark:[stroke:#5b9bd5]" />
            <path d={pathOf("best")} fill="none" stroke="#16a34a" strokeWidth={1.5} />
          </svg>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono whitespace-nowrap min-h-[8.5rem] content-start">
            <span>step</span><span>{sim.step.toLocaleString()} / {sim.steps.toLocaleString()}</span>
            <span>score</span><span>{sim.E.toFixed(1)}</span>
            <span></span><span className="text-neutral-400">{area} area, {wire.toFixed(0)} wire</span>
            <span className="text-green-700 dark:text-green-400">best so far</span><span className="text-green-700 dark:text-green-400">{sim.best.toFixed(1)}</span>
            {!sim.greedy && <><span className="text-amber-600">temperature</span><span className="text-amber-600">{T.toFixed(2)}</span></>}
            <span>worse moves kept</span><span>{sim.keptWorse.toLocaleString()}{recentWorseAll > 0 && <span className="text-neutral-400"> (last 200: {Math.round((100 * recentWorse) / recentWorseAll)}%)</span>}</span>
            <span>last move</span>
            <span style={{ color: flashColor }}>
              {sim.lastMove === "better" ? "better, kept" : sim.lastMove === "worse-kept" ? "worse, kept" : sim.lastMove === "worse-rejected" ? "worse, rejected" : sim.lastMove === "invalid" ? "not a board" : "none yet"}
            </span>
          </div>
          <p className="text-neutral-500 dark:text-neutral-400 min-h-[1.25rem]">{sim.done ? "Finished. Showing the best board of the run." : ""}</p>
        </div>
      </div>
      {caption && <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
