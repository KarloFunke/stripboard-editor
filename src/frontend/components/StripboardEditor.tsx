"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { usePathname } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./stripboard/netCompleteness";
import type { AutoLayoutRequest, AutoLayoutWorkerMessage } from "./stripboard/autoLayoutWorker";
import ComponentTray from "./stripboard/ComponentTray";
import StripboardCanvas from "./stripboard/StripboardCanvas";
import StripboardFootprintEditor from "./stripboard/StripboardFootprintEditor";
import ResizableSidebar from "./ResizableSidebar";
import LayoutRatingPrompt from "./LayoutRatingPrompt";
import { isLayoutRatingEnabled, projectKeyFromPath } from "@/lib/layoutRating";
import { track } from "@/lib/track";
import { LockIcon, UnlockIcon } from "./canvas/SelectionActionBar";

const PHASE_LABELS = {
  arrange: "Arranging parts",
  place: "Placing & routing",
  repair: "Repairing",
} as const;

export default function StripboardEditor({ readOnly = false, hideSidebar = false }: { readOnly?: boolean; hideSidebar?: boolean }) {
  const board = useProjectStore((s) => s.board);
  const setBoardSize = useProjectStore((s) => s.setBoardSize);
  const setBoardDimLock = useProjectStore((s) => s.setBoardDimLock);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const isActive = useProjectStore((s) => s.activeEditor === "stripboard");
  const setActiveEditor = useProjectStore((s) => s.setActiveEditor);
  const showValuesOnBoard = useProjectStore((s) => s.showValuesOnBoard);
  const setShowValuesOnBoard = useProjectStore((s) => s.setShowValuesOnBoard);
  const [editFootprintId, setEditFootprintId] = useState<string | null>(null);
  const applyAutoLayout = useProjectStore((s) => s.applyAutoLayout);
  const setHighlightedNetId = useProjectStore((s) => s.setHighlightedNetId);
  const [autoFinishMsg, setAutoFinishMsg] = useState<string | null>(null);
  const [msgLeaving, setMsgLeaving] = useState(false);
  const autoFinishMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoProgress, setAutoProgress] = useState<{ label: string; frac: number } | null>(null);
  // Snapshot + metrics of a finished v2 layout, shown as a rating prompt in the
  // result popup (only when the user hasn't opted out).
  const [rateData, setRateData] = useState<{ snapshot: Record<string, unknown>; metrics: Record<string, unknown>; runId: number } | null>(null);
  const pathname = usePathname();
  const autoWorkersRef = useRef<Worker[]>([]);
  const autoRunIdRef = useRef(0);
  useEffect(() => () => {
    if (autoFinishMsgTimer.current) clearTimeout(autoFinishMsgTimer.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    autoRunIdRef.current++;
    for (const w of autoWorkersRef.current) w.terminate();
  }, []);

  const clearMsgTimers = () => {
    if (autoFinishMsgTimer.current) clearTimeout(autoFinishMsgTimer.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
  };

  // Fade the popup (and any attached rating prompt) out after 10s. Hovering the
  // popup cancels this and it reschedules on mouse-out, so a user weighing a
  // rating is never rushed.
  const scheduleAutoMsgDismiss = () => {
    clearMsgTimers();
    autoFinishMsgTimer.current = setTimeout(() => {
      setMsgLeaving(true);
      fadeTimerRef.current = setTimeout(() => {
        setAutoFinishMsg(null);
        setRateData(null);
        setMsgLeaving(false);
      }, 500);
    }, 10000);
  };

  const showAutoMsg = (summary: string, issues: string[]) => {
    const msg = issues.length > 0 ? `${summary} · ${issues.join(" · ")}` : summary;
    setMsgLeaving(false);
    setAutoFinishMsg(msg);
    scheduleAutoMsgDismiss();
  };

  const closeAutoMsg = () => {
    clearMsgTimers();
    setAutoFinishMsg(null);
    setRateData(null);
    setMsgLeaving(false);
  };

  const stopAutoWorkers = () => {
    autoRunIdRef.current++;
    for (const w of autoWorkersRef.current) w.terminate();
    autoWorkersRef.current = [];
    setAutoProgress(null);
  };

  // Full runs use the v2 strip-first layouter (deterministic, one worker,
  // picks its own board size). Scoped re-layouts of a selection stay on the
  // v1 optimizer, which can keep everything else fixed.
  const handleAutoLayout = (onlyIds?: string[]) => {
    if (autoWorkersRef.current.length > 0) {
      stopAutoWorkers();
      showAutoMsg("Auto-layout cancelled", []);
      setRateData(null);
      return;
    }
    setRateData(null);
    track("auto-layout-run", { engine: onlyIds ? "selection" : "full" });
    const startedAt = performance.now();
    const runId = ++autoRunIdRef.current;
    const inputs = { board, components, componentDefs, nets, netAssignments };

    const worker = new Worker(new URL("./stripboard/autoLayoutWorker.ts", import.meta.url));
    autoWorkersRef.current = [worker];
    setAutoProgress({ label: "Solving layout", frac: 0 });
    worker.onmessage = (e: MessageEvent<AutoLayoutWorkerMessage>) => {
      if (runId !== autoRunIdRef.current) return;
      if (e.data.type === "progress") {
        const p = e.data.progress;
        setAutoProgress({
          label: `${PHASE_LABELS[p.phase]}${p.attempt > 1 ? ` (attempt ${p.attempt}/${p.maxAttempts})` : ""}`,
          frac: (p.attempt - 1 + p.frac) / p.maxAttempts,
        });
        return;
      }
      stopAutoWorkers();
      const result = e.data.result;
      // The user kept editing while we solved: applying a result computed
      // from stale state would clobber their changes — discard instead.
      const s = useProjectStore.getState();
      if (
        s.board !== inputs.board || s.components !== inputs.components ||
        s.componentDefs !== inputs.componentDefs || s.nets !== inputs.nets ||
        s.netAssignments !== inputs.netAssignments
      ) {
        showAutoMsg("Board changed while solving — result discarded, run again", []);
        return;
      }
      applyAutoLayout(result);
      // Point the user at the first uncompletable net (or clear a stale one)
      setHighlightedNetId(result.starvedNetIds[0] ?? null);
      const parts: string[] = [];
      if (result.placements.length > 0) parts.push(`arranged ${result.placements.length} part${result.placements.length > 1 ? "s" : ""}`);
      if (result.boardSize && (result.boardSize.rows !== inputs.board.rows || result.boardSize.cols !== inputs.board.cols)) {
        parts.push(`board sized to ${result.boardSize.rows}×${result.boardSize.cols}`);
      }
      if (result.cuts.length > 0) parts.push(`${result.cuts.length} cut${result.cuts.length > 1 ? "s" : ""}`);
      if (result.wires.length > 0) parts.push(`${result.wires.length} wire${result.wires.length > 1 ? "s" : ""}`);
      const summary = parts.length > 0
        ? parts.join(", ").replace(/^./, (c) => c.toUpperCase())
        : "Nothing to do";

      // Offer a rating only for full (v2) runs the user hasn't opted out of.
      const rate = !onlyIds && result.placements.length > 0 && isLayoutRatingEnabled(projectKeyFromPath(pathname));
      if (rate) {
        const st = useProjectStore.getState();
        setRateData({
          snapshot: st.exportProject() as unknown as Record<string, unknown>,
          metrics: {
            rows: st.board.rows,
            cols: st.board.cols,
            parts: result.placements.length,
            unplaced: (result.unplaceIds ?? []).length,
            wires: result.wires.length,
            cuts: result.cuts.length,
            quality: result.quality,
            lockedRows: !!st.board.lockedRows,
            lockedCols: !!st.board.lockedCols,
            lockedParts: st.components.filter((c) => c.locked && c.boardPos).length,
            solveMs: Math.round(performance.now() - startedAt),
            issues: result.issues,
          },
          runId,
        });
      }
      showAutoMsg(summary, result.issues);
    };
    worker.onerror = (err) => {
      if (runId !== autoRunIdRef.current) return;
      console.error("Auto-layout worker failed", err);
      stopAutoWorkers();
      showAutoMsg("Auto-layout failed", []);
      setRateData(null);
    };
    const request: AutoLayoutRequest = {
      ...inputs,
      engine: onlyIds ? "v1" : "v2",
      options: onlyIds ? { onlyIds } : undefined,
    };
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
            {autoProgress && (
              <span className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="whitespace-nowrap">{autoProgress.label}</span>
                <span className="w-24 h-1.5 rounded bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                  <span
                    className="block h-full bg-[#113768] dark:bg-[#5b9bd5] transition-[width] duration-200"
                    style={{ width: `${Math.round(autoProgress.frac * 100)}%` }}
                  />
                </span>
              </span>
            )}
            <button
              onClick={() => handleAutoLayout()}
              title={autoProgress
                ? "Cancel the running auto-layout"
                : "Arrange all unlocked parts and regenerate the cuts and link wires to complete the board. Lock components to keep them in place."}
              className="border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              {autoProgress ? "Cancel" : "Auto-layout (alpha)"}
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
              <button
                onClick={() => setBoardDimLock("rows", !board.lockedRows)}
                title={board.lockedRows
                  ? "Row count is locked: auto-layout keeps exactly this many rows. Click to let it choose freely."
                  : "Auto-layout chooses the row count. Click to lock it to the value on the left."}
                className={`p-1 rounded border transition-colors ${board.lockedRows
                  ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
                  : "border-neutral-300 dark:border-neutral-600 text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
              >
                {board.lockedRows ? LockIcon : UnlockIcon}
              </button>
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
              <button
                onClick={() => setBoardDimLock("cols", !board.lockedCols)}
                title={board.lockedCols
                  ? "Column count is locked: auto-layout keeps exactly this many columns. Click to let it choose freely."
                  : "Auto-layout chooses the column count. Click to lock it to the value on the left."}
                className={`p-1 rounded border transition-colors ${board.lockedCols
                  ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
                  : "border-neutral-300 dark:border-neutral-600 text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
              >
                {board.lockedCols ? LockIcon : UnlockIcon}
              </button>
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
          <StripboardCanvas
            readOnly={readOnly}
            onEditFootprint={setEditFootprintId}
            onAutoLayoutSelection={readOnly ? undefined : (ids) => handleAutoLayout(ids)}
          />
        </div>
      </div>
      {!readOnly && autoFinishMsg && (
        <div
          className={`absolute top-16 left-1/2 -translate-x-1/2 z-40 max-w-lg w-[calc(100%-2rem)] sm:w-auto transition-opacity duration-500 ${msgLeaving ? "opacity-0" : "opacity-100"}`}
          onMouseEnter={() => { clearMsgTimers(); setMsgLeaving(false); }}
          onMouseLeave={scheduleAutoMsgDismiss}
        >
          <div className="flex items-start gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 shadow-lg dark:shadow-neutral-900/50">
            <div className="flex-1">
              <p className="text-sm text-neutral-700 dark:text-neutral-200 leading-snug">
                {autoFinishMsg}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5">
                Interested in how it works?{" "}
                <a
                  href="/guide/auto-layout"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  See here
                </a>
              </p>
              {rateData && (
                <LayoutRatingPrompt
                  key={rateData.runId}
                  snapshot={rateData.snapshot}
                  metrics={rateData.metrics}
                  onDone={closeAutoMsg}
                />
              )}
            </div>
            <button
              onClick={closeAutoMsg}
              title="Dismiss"
              className="mt-0.5 shrink-0 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-100 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
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
