"use client";

import { useEffect, useRef, useState } from "react";
import { RunEta, leftText } from "./layoutEta";

// The auto-layout progress bar. With a run's time estimate it moves every
// frame from the predicted end time, so it runs at an even pace instead of
// stepping with each report; without one it shows the fraction it is given.
export default function AutoProgressBar({ label, frac, eta }: { label: string; frac: number; eta?: RunEta }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<string>();
  useEffect(() => {
    if (!eta) return;
    let raf = 0;
    const tick = () => {
      const v = eta.view(Date.now());
      if (barRef.current) barRef.current.style.width = `${v.frac * 100}%`;
      const text = v.left !== undefined ? leftText(v.left) : undefined;
      setLeft((old) => (old === text ? old : text));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [eta]);
  return (
    <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
      <div className="truncate" title={label}>{label}</div>
      <div className="mt-1 h-1.5 rounded bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
        <div
          ref={barRef}
          className={`relative h-full overflow-hidden bg-[#113768] dark:bg-[#5b9bd5] ${eta ? "" : "transition-[width] duration-200"}`}
          // with an estimate the width is written every frame (the prop stays
          // 0%, so React never resets it)
          style={{ width: eta ? "0%" : `${Math.round(frac * 100)}%` }}
        >
          <span className="progress-sheen absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        </div>
      </div>
      {eta && left && <div className="mt-1 tabular-nums">{left}</div>}
    </div>
  );
}
