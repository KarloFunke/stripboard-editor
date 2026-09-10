"use client";

import { useEffect, useState } from "react";
import type { LabStep } from "@/components/stripboard/autoLayout5";
import { LAB } from "./lab";
import BoardView from "./BoardView";
import { useInView } from "./useInView";

// ── Section 8: a whole run on the example, start to finish ──
// The real anneal loop of the layouter on the example circuit: a random
// description, the real moves, the real schedule. The run is computed
// first, then replayed with the board redrawn as it goes.

// One canvas for every run, so nothing on the page moves while it plays. It
// holds the board of a settled run with room to spare; the rough boards of the
// first few percent can run past its edge, which beats drawing every board at
// the size of the worst one.
const SIZE = { rows: 20, cols: 18 };

export default function MiniRun({ seed = 1, steps: initialSteps = 10000, caption }: { seed?: number; steps?: number; caption?: string }) {
  const [fig, seen] = useInView<HTMLElement>();
  const [steps, setSteps] = useState(initialSteps);
  const [speed, setSpeed] = useState(2);
  const [seedN, setSeedN] = useState(seed);
  const [snaps, setSnaps] = useState<LabStep[] | null>(null);
  const [i, setI] = useState(0);
  const [running, setRunning] = useState(false);
  const every = Math.max(1, Math.floor(steps / 1500));

  useEffect(() => {
    setSnaps(null);
    setI(0);
    setRunning(false);
    if (!seen) return;
    const t = setTimeout(() => {
      const out: LabStep[] = [];
      LAB.run(seedN, steps, every, (s) => out.push({ ...s, g: LAB.cloneG(s.g) }));
      setSnaps(out);
    }, 20);
    return () => clearTimeout(t);
  }, [seedN, steps, every, seen]);

  useEffect(() => {
    if (!running || !snaps) return;
    let raf = 0;
    let acc = 0;
    const loop = () => {
      acc += speed;
      const n = Math.floor(acc);
      acc -= n;
      if (n > 0) {
        setI((k) => {
          const m = Math.min(snaps.length - 1, k + n);
          if (m >= snaps.length - 1) setRunning(false);
          return m;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, snaps]);

  const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";
  const sel = "px-1.5 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100";
  const s = snaps ? snaps[Math.min(i, snaps.length - 1)] : null;
  const done = !!snaps && i >= snaps.length - 1;
  const shown = s ? (done ? s.bestD : s.d) : null;
  const flash = s?.kind === "better" ? "#16a34a" : s?.kind === "worse-kept" ? "#f59e0b" : s?.kind === "worse-rejected" ? "#dc2626" : "#9ca3af";
  const TW = 320, TH = 130, PAD = 4;
  const tr = snaps ? snaps.slice(0, Math.max(1, i + 1)) : [];
  const lo = tr.length ? Math.max(1, Math.min(...tr.map((t) => t.best)) * 0.9) : 1, hi = tr.length ? Math.max(...tr.map((t) => t.E), lo * 1.1) : 2;
  const xAt = (k: number) => PAD + (k / Math.max(1, (snaps?.length ?? 1) - 1)) * (TW - 2 * PAD);
  const yAt = (e: number) => PAD + (1 - Math.log(Math.max(e, lo) / lo) / Math.log(hi / lo)) * (TH - 2 * PAD);
  const pathOf = (key: "E" | "best") => tr.map((t, k) => `${k === 0 ? "M" : "L"}${xAt(k).toFixed(1)},${yAt(t[key]).toFixed(1)}`).join(" ");
  const tPath = tr.map((t, k) => `${k === 0 ? "M" : "L"}${xAt(k).toFixed(1)},${(PAD + (1 - Math.log(t.T / 0.15) / Math.log(LAB.T_START / 0.15)) * (TH - 2 * PAD)).toFixed(1)}`).join(" ");

  return (
    <figure ref={fig} className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={btn} onClick={() => { if (done) setI(0); setRunning((r) => !r); }} disabled={!snaps}>{running ? "Pause" : done ? "Replay" : i === 0 ? "Play" : "Continue"}</button>
        <button className={btn} onClick={() => { setRunning(false); setI((k) => Math.min((snaps?.length ?? 1) - 1, k + 1)); }} disabled={!snaps || done} title="Advance one recorded step">+1 step</button>
        <button className={btn} onClick={() => { setRunning(false); setI(0); }} disabled={!snaps || i === 0}>Restart</button>
        <button className={btn} onClick={() => setSeedN((x) => x + 1)}>New start</button>
        <select className={sel} value={steps} onChange={(e) => setSteps(Number(e.target.value))}>
          <option value={5000}>5,000 steps</option>
          <option value={10000}>10,000 steps</option>
          <option value={25000}>25,000 steps</option>
        </select>
        <select className={sel} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Recorded steps per animation frame">
          <option value={0.25}>slow</option>
          <option value={2}>normal</option>
          <option value={8}>fast</option>
          <option value={60}>instant</option>
        </select>
        {!snaps && <span className="text-xs text-neutral-500">running the layouter…</span>}
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <div className="h-[25rem] min-w-0 [&>svg]:max-h-full [&>svg]:max-w-full [&>svg]:w-auto [&>svg]:h-auto">
          {shown && <BoardView state={shown.board} rows={SIZE.rows} cols={SIZE.cols} fixed />}
        </div>
        <div className="flex-1 min-w-0 text-xs text-neutral-700 dark:text-neutral-300 space-y-2">
          <svg width={TW} height={TH} viewBox={`0 0 ${TW} ${TH}`} className="max-w-full h-auto rounded bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700">
            {tr.length > 1 && <path d={tPath} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" />}
            {tr.length > 1 && <path d={pathOf("E")} fill="none" stroke="#113768" strokeWidth={1.2} className="dark:[stroke:#5b9bd5]" />}
            {tr.length > 1 && <path d={pathOf("best")} fill="none" stroke="#16a34a" strokeWidth={1.5} />}
          </svg>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono min-h-[12rem] content-start">
            <span>step</span><span>{s ? `${s.it.toLocaleString()} / ${s.moves.toLocaleString()}` : ""}</span>
            <span>score</span><span>{s ? s.E.toFixed(1) : ""}</span>
            <span></span><span className="text-neutral-400">{shown ? `${shown.H * shown.W} cells, ${shown.wires} wires, ${shown.cuts} cuts` : ""}</span>
            <span></span><span className="text-neutral-400">{shown ? `${shown.mess} messy, ${shown.starved} unreachable` : ""}</span>
            <span className="text-green-700 dark:text-green-400">best so far</span><span className="text-green-700 dark:text-green-400">{s ? s.best.toFixed(1) : ""}</span>
            <span className="text-amber-600">temperature</span><span className="text-amber-600">{s ? s.T.toFixed(2) : ""}</span>
            <span>mess price</span><span>{s ? s.w.toFixed(0) : ""}</span>
            <span>last move</span><span style={{ color: flash }}>{s ? (s.kind === "better" ? "better, kept" : s.kind === "worse-kept" ? "worse, kept" : s.kind === "worse-rejected" ? "worse, rejected" : s.kind === "infeasible" ? "cannot be built, rejected" : "no change") : ""}</span>
          </div>
          <p className="text-neutral-500 dark:text-neutral-400 min-h-[1.25rem]">{done ? "Finished. Showing the best board of the run." : ""}</p>
        </div>
      </div>
      {caption && <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
