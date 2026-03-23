"use client";

import { useRef, useState, useCallback } from "react";

interface Props {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultSplit?: number; // 0-1, default 0.5
  minSplit?: number;
  maxSplit?: number;
}

export default function SplitPane({
  left,
  right,
  defaultSplit = 0.5,
  minSplit = 0.25,
  maxSplit = 0.75,
}: Props) {
  const [split, setSplit] = useState(defaultSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      setSplit(Math.min(maxSplit, Math.max(minSplit, ratio)));
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [minSplit, maxSplit]);

  const leftPercent = `${split * 100}%`;
  const rightPercent = `${(1 - split) * 100}%`;

  return (
    <div ref={containerRef} className="flex flex-1 min-h-0 relative">
      <div style={{ width: leftPercent }} className="min-w-0 overflow-hidden">
        {left}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className="w-1 flex-shrink-0 cursor-col-resize bg-[#113768]/20 hover:bg-[#113768]/40 active:bg-[#113768]/50 dark:bg-[#5b9bd5]/30 dark:hover:bg-[#5b9bd5]/50 dark:active:bg-[#5b9bd5]/60 transition-colors z-10"
      />
      <div style={{ width: rightPercent }} className="min-w-0 overflow-hidden">
        {right}
      </div>
    </div>
  );
}
