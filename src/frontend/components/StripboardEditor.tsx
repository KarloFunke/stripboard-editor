"use client";

import { useState, useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./stripboard/netCompleteness";
import ComponentTray from "./stripboard/ComponentTray";
import StripboardCanvas from "./stripboard/StripboardCanvas";
import StripboardFootprintEditor from "./stripboard/StripboardFootprintEditor";
import ResizableSidebar from "./ResizableSidebar";

export default function StripboardEditor({ readOnly = false, hideSidebar = false }: { readOnly?: boolean; hideSidebar?: boolean }) {
  const board = useProjectStore((s) => s.board);
  const setBoardSize = useProjectStore((s) => s.setBoardSize);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const [editFootprintId, setEditFootprintId] = useState<string | null>(null);

  const { segments, connectivity, conflictCount } = useStripSegments();

  const incompleteNets = useMemo(
    () => checkNetCompleteness(nets, netAssignments, segments, connectivity, components, componentDefs),
    [nets, netAssignments, segments, connectivity, components, componentDefs]
  );

  const allPlaced = components.length >= 2 && components.every((c) => c.boardPos !== null);
  const allNetsUsed = allPlaced && components.every((c) =>
    netAssignments.some((a) => a.componentId === c.id)
  );
  const allDone = allPlaced && allNetsUsed && conflictCount === 0 && incompleteNets.length === 0;

  // Status indicator for the header
  let statusText = "";
  let statusColor = "";
  if (allDone) {
    statusText = "All done";
    statusColor = "text-green-600 dark:text-green-400";
  } else if (conflictCount > 0) {
    statusText = `${conflictCount} conflict${conflictCount > 1 ? "s" : ""}`;
    statusColor = "text-red-600";
  }

  return (
    <div className="flex h-full flex-col">
      {!hideSidebar && <div className="border-b border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-5 h-12 font-semibold text-sm text-[#113768] dark:text-[#5b9bd5] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span>Stripboard Layout</span>
          {statusText && (
            <span className={`text-xs font-medium ${statusColor}`}>
              {statusText}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-4 text-sm font-normal text-neutral-600 dark:text-neutral-400">
            <div className="flex items-center gap-1.5">
              <span>Rows:</span>
              <input
                type="number"
                min={1}
                max={100}
                value={board.rows}
                onChange={(e) => setBoardSize(Math.max(1, parseInt(e.target.value) || 1), board.cols)}
                className="w-[4.5rem] border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400 text-center"
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
                className="w-[4.5rem] border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400 text-center"
              />
            </div>
          </div>
        )}
      </div>}
      <div className="flex flex-1 min-h-0">
        {!hideSidebar && (
          readOnly ? (
            <div className="w-48 flex-shrink-0 flex flex-col overflow-hidden border-r border-neutral-200 dark:border-neutral-700">
              <ComponentTray readOnly />
            </div>
          ) : (
            <ResizableSidebar defaultWidth={200} minWidth={140} maxWidth={360}>
              <div className="flex flex-col h-full overflow-hidden border-r border-neutral-200 dark:border-neutral-700">
                <ComponentTray onEditFootprint={setEditFootprintId} />
              </div>
            </ResizableSidebar>
          )
        )}
        <div className="flex-1 min-w-0">
          <StripboardCanvas readOnly={readOnly} />
        </div>
      </div>
      {editFootprintId && (
        <StripboardFootprintEditor
          componentId={editFootprintId}
          onClose={() => setEditFootprintId(null)}
        />
      )}
    </div>
  );
}
