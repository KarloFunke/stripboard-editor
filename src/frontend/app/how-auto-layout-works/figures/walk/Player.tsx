"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { LabFrame } from "@/components/stripboard/autoLayout5";
import { trackDemo } from "../trackDemo";

// ── Steps through the frames of one decode stage ──

const btn = "px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-100 disabled:opacity-40";

export default function Player({ demo, frames, render, caption, stepMs = 1100 }: { demo: string; frames: LabFrame[]; render: (f: LabFrame) => ReactNode; caption?: ReactNode; stepMs?: number }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (i >= frames.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI((k) => Math.min(frames.length - 1, k + 1)), stepMs);
    return () => clearTimeout(t);
  }, [playing, i, frames.length, stepMs]);
  const f = frames[Math.min(i, frames.length - 1)];
  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4">
      {frames.length > 1 && <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className={btn} onClick={() => { trackDemo(demo, "step"); setPlaying(false); setI((k) => Math.max(0, k - 1)); }} disabled={i === 0}>&larr;</button>
        <button className={btn} onClick={() => { trackDemo(demo, "step"); setPlaying(false); setI((k) => Math.min(frames.length - 1, k + 1)); }} disabled={i >= frames.length - 1}>&rarr;</button>
        <button className={btn} onClick={() => { trackDemo(demo, "play"); if (i >= frames.length - 1) setI(0); setPlaying((p) => !p); }}>{playing ? "Pause" : i >= frames.length - 1 ? "Replay" : "Play"}</button>
        <button className={btn} onClick={() => { trackDemo(demo, "restart"); setPlaying(false); setI(0); }} disabled={i === 0}>Restart</button>
        <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400">{i + 1} / {frames.length}</span>
      </div>}
      <div className="flex flex-col gap-3">
        {render(f)}
        <p className="text-sm text-neutral-800 dark:text-neutral-200 leading-relaxed min-h-[4.5rem]">{f.msg}</p>
      </div>
      {caption && <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
