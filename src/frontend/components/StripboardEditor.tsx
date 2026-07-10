"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./stripboard/netCompleteness";
import type { AutoLayoutProgress } from "./stripboard/autoLayout";
import type { AutoLayoutRequest, AutoLayoutWorkerMessage } from "./stripboard/autoLayoutWorker";
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
  const isActive = useProjectStore((s) => s.activeEditor === "stripboard");
  const setActiveEditor = useProjectStore((s) => s.setActiveEditor);
  const showValuesOnBoard = useProjectStore((s) => s.showValuesOnBoard);
  const setShowValuesOnBoard = useProjectStore((s) => s.setShowValuesOnBoard);
  const [editFootprintId, setEditFootprintId] = useState<string | null>(null);
  const autoFinishBoard = useProjectStore((s) => s.autoFinishBoard);
  const applyAutoLayout = useProjectStore((s) => s.applyAutoLayout);
  const [autoFinishMsg, setAutoFinishMsg] = useState<string | null>(null);
  const autoFinishMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoProgress, setAutoProgress] = useState<AutoLayoutProgress | null>(null);
  const autoWorkerRef = useRef<Worker | null>(null);
  useEffect(() => () => {
    if (autoFinishMsgTimer.current) clearTimeout(autoFinishMsgTimer.current);
    autoWorkerRef.current?.terminate();
  }, []);

  const showAutoMsg = (summary: string, issues: string[]) => {
    const msg = issues.length > 0 ? `${summary} · ${issues.join(" · ")}` : summary;
    setAutoFinishMsg(msg);
    if (autoFinishMsgTimer.current) clearTimeout(autoFinishMsgTimer.current);
    autoFinishMsgTimer.current = setTimeout(() => setAutoFinishMsg(null), 8000);
  };

  const handleAutoFinish = () => {
    const result = autoFinishBoard();
    const added: string[] = [];
    if (result.cuts.length > 0) added.push(`${result.cuts.length} cut${result.cuts.length > 1 ? "s" : ""}`);
    if (result.wires.length > 0) added.push(`${result.wires.length} wire${result.wires.length > 1 ? "s" : ""}`);
    showAutoMsg(added.length > 0 ? `Added ${added.join(" and ")}` : "Nothing to add", result.issues);
  };

  const stopAutoWorker = () => {
    autoWorkerRef.current?.terminate();
    autoWorkerRef.current = null;
    setAutoProgress(null);
  };

  const handleAutoLayout = () => {
    if (autoWorkerRef.current) {
      stopAutoWorker();
      showAutoMsg("Auto-layout cancelled", []);
      return;
    }
    const worker = new Worker(new URL("./stripboard/autoLayoutWorker.ts", import.meta.url));
    autoWorkerRef.current = worker;
    setAutoProgress({ phase: "arrange", attempt: 1, maxAttempts: 1, frac: 0 });
    worker.onmessage = (e: MessageEvent<AutoLayoutWorkerMessage>) => {
      if (e.data.type === "progress") {
        setAutoProgress(e.data.progress);
        return;
      }
      stopAutoWorker();
      const result = e.data.result;
      applyAutoLayout(result);
      const parts: string[] = [];
      if (result.placements.length > 0) parts.push(`arranged ${result.placements.length} part${result.placements.length > 1 ? "s" : ""}`);
      if (result.cuts.length > 0) parts.push(`${result.cuts.length} cut${result.cuts.length > 1 ? "s" : ""}`);
      if (result.wires.length > 0) parts.push(`${result.wires.length} wire${result.wires.length > 1 ? "s" : ""}`);
      const summary = parts.length > 0
        ? parts.join(", ").replace(/^./, (c) => c.toUpperCase())
        : "Nothing to do";
      showAutoMsg(summary, result.issues);
    };
    worker.onerror = (err) => {
      console.error("Auto-layout worker failed", err);
      stopAutoWorker();
      showAutoMsg("Auto-layout failed", []);
    };
    const request: AutoLayoutRequest = { board, components, componentDefs, nets, netAssignments };
    worker.postMessage(request);
  };

  const { segments, connectivity, conflictCount } = useStripSegments();

  const incompleteNets = useMemo(
    () => checkNetCompleteness(nets, netAssignments, segments, connectivity, components, componentDefs),
    [nets, netAssignments, segments, connectivity, components, componentDefs]
  );

  // Off-board components don't count toward board completion.
  const boardComponents = components.filter((c) => !c.boardExcluded);
  const allPlaced = boardComponents.length >= 2 && boardComponents.every((c) => c.boardPos !== null);
  const allNetsUsed = allPlaced && boardComponents.every((c) =>
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
    <div
      className="relative flex h-full flex-col"
      onMouseDownCapture={readOnly ? undefined : () => setActiveEditor("stripboard")}
    >
      {!hideSidebar && <div className="border-b border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-5 h-12 font-semibold text-sm text-[#113768] dark:text-[#5b9bd5] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono">Stripboard Layout</span>
          {statusText && (
            <span className={`text-xs font-medium ${statusColor}`}>
              {statusText}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-4 font-mono text-sm font-normal text-neutral-600 dark:text-neutral-400">
            {autoProgress ? (
              <span className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="whitespace-nowrap">
                  {{ arrange: "Arranging parts", place: "Placing & routing", repair: "Repairing" }[autoProgress.phase]}
                  {autoProgress.attempt > 1 ? ` (attempt ${autoProgress.attempt}/${autoProgress.maxAttempts})` : ""}
                </span>
                <span className="w-24 h-1.5 rounded bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                  <span
                    className="block h-full bg-[#113768] dark:bg-[#5b9bd5] transition-[width] duration-200"
                    style={{ width: `${Math.round(autoProgress.frac * 100)}%` }}
                  />
                </span>
              </span>
            ) : autoFinishMsg && (
              <span
                className="max-w-72 truncate text-xs text-neutral-500 dark:text-neutral-400"
                title={autoFinishMsg}
              >
                {autoFinishMsg}
              </span>
            )}
            <button
              onClick={handleAutoLayout}
              title={autoProgress
                ? "Cancel the running auto-layout"
                : "Arrange all unlocked parts and regenerate the cuts and link wires to complete the board. Lock components to keep them in place."}
              className="border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              {autoProgress ? "Cancel" : "Auto-layout"}
            </button>
            <button
              onClick={handleAutoFinish}
              disabled={!!autoProgress}
              title="Add the strip cuts and link wires needed to complete the current placement"
              className="border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              Auto-finish
            </button>
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
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!showValuesOnBoard}
                onChange={(e) => setShowValuesOnBoard(e.target.checked)}
                className="cursor-pointer accent-[#113768] dark:accent-[#5b9bd5]"
              />
              <span>show component Values</span>
            </label>
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
                <ComponentTray />
              </div>
            </ResizableSidebar>
          )
        )}
        <div className="flex-1 min-w-0">
          <StripboardCanvas readOnly={readOnly} onEditFootprint={setEditFootprintId} />
        </div>
      </div>
      {editFootprintId && (
        <StripboardFootprintEditor
          componentId={editFootprintId}
          onClose={() => setEditFootprintId(null)}
        />
      )}
      {!readOnly && isActive && (
        <div className="pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-[var(--copper)]/70" />
      )}
    </div>
  );
}
