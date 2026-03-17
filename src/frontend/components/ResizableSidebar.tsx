"use client";

import { useRef, useState, useCallback } from "react";

interface ResizableSidebarProps {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  children: React.ReactNode;
  side?: "left" | "right";
}

export default function ResizableSidebar({
  defaultWidth,
  minWidth,
  maxWidth,
  children,
  side = "left",
}: ResizableSidebarProps) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = side === "left"
        ? ev.clientX - startX.current
        : startX.current - ev.clientX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
      setWidth(newWidth);
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
  }, [width, minWidth, maxWidth, side]);

  return (
    <div
      className="flex-shrink-0 flex flex-col overflow-hidden relative"
      style={{ width }}
    >
      {children}
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#113768]/20 active:bg-[#113768]/30 transition-colors z-10 ${
          side === "left" ? "right-0" : "left-0"
        }`}
      />
    </div>
  );
}
