"use client";

import { useProjectStore } from "@/store/useProjectStore";
import ComponentTray from "./stripboard/ComponentTray";
import StripboardCanvas from "./stripboard/StripboardCanvas";

export default function StripboardEditor() {
  const board = useProjectStore((s) => s.board);
  const setBoardSize = useProjectStore((s) => s.setBoardSize);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-300 bg-white px-4 h-10 font-semibold text-sm text-[#113768] flex items-center justify-between">
        <span>Stripboard Layout</span>
        <div className="flex items-center gap-3 text-xs font-normal text-neutral-600">
          <div className="flex items-center gap-1">
            <span>Rows:</span>
            <input
              type="number"
              min={1}
              max={100}
              value={board.rows}
              onChange={(e) => setBoardSize(Math.max(1, parseInt(e.target.value) || 1), board.cols)}
              className="w-16 border border-neutral-300 rounded px-1.5 py-0.5 text-xs text-neutral-900 outline-none focus:border-blue-400 text-center"
            />
          </div>
          <div className="flex items-center gap-1">
            <span>Cols:</span>
            <input
              type="number"
              min={1}
              max={100}
              value={board.cols}
              onChange={(e) => setBoardSize(board.rows, Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16 border border-neutral-300 rounded px-1.5 py-0.5 text-xs text-neutral-900 outline-none focus:border-blue-400 text-center"
            />
          </div>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-44 flex-shrink-0 border-r border-neutral-200 flex flex-col overflow-hidden">
          <ComponentTray />
        </div>
        <div className="flex-1 min-w-0">
          <StripboardCanvas />
        </div>
      </div>
    </div>
  );
}
