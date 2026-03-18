"use client";

import { useProjectStore } from "@/store/useProjectStore";
import ComponentTray from "./stripboard/ComponentTray";
import StripboardCanvas from "./stripboard/StripboardCanvas";
import ResizableSidebar from "./ResizableSidebar";

export default function StripboardEditor({ readOnly = false }: { readOnly?: boolean }) {
  const board = useProjectStore((s) => s.board);
  const setBoardSize = useProjectStore((s) => s.setBoardSize);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-300 bg-white px-5 h-12 font-semibold text-sm text-[#113768] flex items-center justify-between">
        <span>Stripboard Layout</span>
        {!readOnly && (
          <div className="flex items-center gap-4 text-sm font-normal text-neutral-600">
            <div className="flex items-center gap-1.5">
              <span>Rows:</span>
              <input
                type="number"
                min={1}
                max={100}
                value={board.rows}
                onChange={(e) => setBoardSize(Math.max(1, parseInt(e.target.value) || 1), board.cols)}
                className="w-[4.5rem] border border-neutral-300 rounded px-2 py-1 text-sm text-neutral-900 outline-none focus:border-blue-400 text-center"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span>Cols:</span>
              <input
                type="number"
                min={1}
                max={100}
                value={board.cols}
                onChange={(e) => setBoardSize(board.rows, Math.max(1, parseInt(e.target.value) || 1))}
                className="w-[4.5rem] border border-neutral-300 rounded px-2 py-1 text-sm text-neutral-900 outline-none focus:border-blue-400 text-center"
              />
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-1 min-h-0">
        {readOnly ? (
          <div className="w-48 flex-shrink-0 flex flex-col overflow-hidden border-r border-neutral-200">
            <ComponentTray readOnly />
          </div>
        ) : (
          <ResizableSidebar defaultWidth={200} minWidth={140} maxWidth={360}>
            <div className="flex flex-col h-full overflow-hidden border-r border-neutral-200">
              <ComponentTray />
            </div>
          </ResizableSidebar>
        )}
        <div className="flex-1 min-w-0">
          <StripboardCanvas readOnly={readOnly} />
        </div>
      </div>
    </div>
  );
}
