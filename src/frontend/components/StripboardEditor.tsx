"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./stripboard/netCompleteness";
import type { AutoLayoutRequest, AutoLayoutWorkerMessage } from "./stripboard/autoLayoutWorker";
import { DEFAULT_PERM_TIME_BUDGET, defaultPermWorkers, type AutoLayoutResult } from "./stripboard/layoutTypes";
import ComponentTray from "./stripboard/ComponentTray";
import StripboardCanvas from "./stripboard/StripboardCanvas";
import StripboardFootprintEditor from "./stripboard/StripboardFootprintEditor";
import AutoLayoutSettings from "./stripboard/AutoLayoutSettings";
import BoardConfigPanel from "./stripboard/BoardConfigPanel";
import { hasCustomLayout } from "./stripboard/boardTopology";
import ResizableSidebar from "./ResizableSidebar";
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
  const spanOverrides = useProjectStore((s) => s.spanOverrides);
  const clearanceOverrides = useProjectStore((s) => s.clearanceOverrides);
  const tidyWires = useProjectStore((s) => s.tidyWires);
  const permTimeBudget = useProjectStore((s) => s.permTimeBudget);
  const permWorkers = useProjectStore((s) => s.permWorkers);
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
  const [showLayoutSettings, setShowLayoutSettings] = useState(false);
  const [showBoardConfig, setShowBoardConfig] = useState(false);
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

  // Fade the popup out after 10s. Hovering the popup cancels this and it
  // reschedules on mouse-out.
  const scheduleAutoMsgDismiss = () => {
    clearMsgTimers();
    autoFinishMsgTimer.current = setTimeout(() => {
      setMsgLeaving(true);
      fadeTimerRef.current = setTimeout(() => {
        setAutoFinishMsg(null);
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
    setMsgLeaving(false);
  };

  const stopAutoWorkers = () => {
    autoRunIdRef.current++;
    for (const w of autoWorkersRef.current) w.terminate();
    autoWorkersRef.current = [];
    setAutoProgress(null);
  };

  // Full runs use the v2 strip-first layouter (deterministic, picks its own
  // board size). Scoped re-layouts of a selection stay on the v1 optimizer,
  // which can keep everything else fixed. With a time budget set, several
  // workers solve deterministic input orderings of the same circuit until
  // the time is up and the best finished board (quality, then score) wins.
  const handleAutoLayout = (onlyIds?: string[]) => {
    if (autoWorkersRef.current.length > 0) {
      stopAutoWorkers();
      showAutoMsg("Auto-layout cancelled", []);
      return;
    }
    track("auto-layout-run", { engine: onlyIds ? "selection" : "full" });
    const runId = ++autoRunIdRef.current;
    // A configured board is a physical object: its rails, strip breaks and
    // snap lines are pinned to specific rows and columns, so the solver may
    // not resize it out from under them.
    const solveBoard = hasCustomLayout(board)
      ? { ...board, lockedRows: true, lockedCols: true }
      : board;
    const inputs = { board: solveBoard, components, componentDefs, nets, netAssignments, spanOverrides, clearanceOverrides, tidyWires };

    const isStale = () => {
      const s = useProjectStore.getState();
      return (
        s.board !== board || s.components !== inputs.components ||
        s.componentDefs !== inputs.componentDefs || s.nets !== inputs.nets ||
        s.netAssignments !== inputs.netAssignments || s.spanOverrides !== inputs.spanOverrides ||
        s.clearanceOverrides !== inputs.clearanceOverrides || s.tidyWires !== inputs.tidyWires
      );
    };
    const applyBest = (result: AutoLayoutResult, meta?: { budget: number; orderings: number }) => {
      // The user kept editing while we solved: applying a result computed
      // from stale state would clobber their changes — discard instead.
      if (isStale()) {
        showAutoMsg("Board changed while solving — result discarded, run again", []);
        return;
      }
      applyAutoLayout(result, meta);
      // Point the user at the first uncompletable net (or clear a stale one)
      setHighlightedNetId(result.starvedNetIds[0] ?? null);
      // A clean run speaks for itself on the board; only problems get a popup.
      if (result.issues.length > 0) showAutoMsg("Auto-layout finished with issues", result.issues);
    };
    const request: AutoLayoutRequest = {
      ...inputs,
      engine: onlyIds ? "v1" : "v2",
      options: onlyIds ? { onlyIds } : undefined,
      tidyGrowth: tidyWires === false ? undefined : Infinity,
    };

    const budget = !onlyIds ? permTimeBudget ?? DEFAULT_PERM_TIME_BUDGET : 0;
    if (budget > 0) {
      const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
      const nWorkers = Math.max(1, Math.min(permWorkers ?? defaultPermWorkers(cores), cores - 1));
      const deadline = Date.now() + budget * 1000;
      let nextIdx = 0;
      let inFlight = 0;
      let solved = 0;
      let best: { result: AutoLayoutResult; score: number; index: number } | null = null;

      const progressTimer = setInterval(() => {
        if (runId !== autoRunIdRef.current) {
          clearInterval(progressTimer);
          return;
        }
        setAutoProgress({
          label: `Solving layouts (${solved} done)`,
          frac: Math.min(1, (Date.now() - (deadline - budget * 1000)) / (budget * 1000)),
        });
      }, 200);

      const finalize = () => {
        clearInterval(progressTimer);
        stopAutoWorkers();
        if (best) applyBest(best.result, { budget, orderings: solved });
        else showAutoMsg("Auto-layout failed", []);
      };
      // Every worker gets a first ordering regardless of the clock; after
      // that, new orderings are handed out only while time remains.
      const dispatch = (worker: Worker & { _idx?: number }): boolean => {
        if (nextIdx >= nWorkers && Date.now() >= deadline) return false;
        worker._idx = nextIdx++;
        inFlight++;
        worker.postMessage({ ...request, permutationIndex: worker._idx });
        return true;
      };
      const workers = Array.from({ length: nWorkers }, () => {
        const worker: Worker & { _idx?: number } = new Worker(new URL("./stripboard/autoLayoutWorker.ts", import.meta.url));
        worker.onmessage = (e: MessageEvent<AutoLayoutWorkerMessage>) => {
          if (runId !== autoRunIdRef.current) return;
          if (e.data.type === "progress") return; // the bar tracks the clock
          inFlight--;
          solved++;
          const { result } = e.data;
          const score = e.data.score ?? Infinity;
          const idx = worker._idx!;
          // Deterministic winner for a given set of finished orderings:
          // quality, then score, then the earliest ordering.
          if (!best || result.quality < best.result.quality ||
              (result.quality === best.result.quality &&
                (score < best.score || (score === best.score && idx < best.index)))) {
            best = { result, score, index: idx };
          }
          if (!dispatch(worker) && inFlight === 0) finalize();
        };
        worker.onerror = (err) => {
          if (runId !== autoRunIdRef.current) return;
          console.error("Auto-layout worker failed", err);
          inFlight--;
          worker.terminate();
          autoWorkersRef.current = autoWorkersRef.current.filter((w) => w !== worker);
          if (inFlight === 0) finalize();
        };
        return worker;
      });
      autoWorkersRef.current = workers;
      setAutoProgress({ label: "Solving layouts", frac: 0 });
      for (const w of workers) dispatch(w);
      return;
    }

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
      applyBest(e.data.result);
    };
    worker.onerror = (err) => {
      if (runId !== autoRunIdRef.current) return;
      console.error("Auto-layout worker failed", err);
      stopAutoWorkers();
      showAutoMsg("Auto-layout failed", []);
    };
    worker.postMessage(request);
  };

  const { segments, connectivity, conflictCount } = useStripSegments();
  const boardIsCustom = hasCustomLayout(board);
  // A map states the board's size, so the size fields report rather than set it.
  const boardIsMapped = board.layout?.map !== undefined;

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
                    className="relative block h-full overflow-hidden bg-[#113768] dark:bg-[#5b9bd5] transition-[width] duration-200"
                    style={{ width: `${Math.round(autoProgress.frac * 100)}%` }}
                  >
                    <span className="progress-sheen absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                  </span>
                </span>
              </span>
            )}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleAutoLayout()}
                title={autoProgress
                  ? "Cancel the running auto-layout"
                  : "Arrange all unlocked parts and regenerate the cuts and link wires to complete the board. Lock components to keep them in place."}
                className="border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
              >
                {autoProgress ? "Cancel" : "Auto-layout"}
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowLayoutSettings((v) => !v)}
                  title="Auto-layout settings"
                  className={`p-1.5 rounded border transition-colors ${showLayoutSettings
                    ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
                    : "border-neutral-300 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                {showLayoutSettings && <AutoLayoutSettings onClose={() => setShowLayoutSettings(false)} />}
              </div>
            </div>
            <div className="relative">
              <button
                onClick={() => setShowBoardConfig((v) => !v)}
                title="Choose the board you are building on, or describe a custom one: strip breaks, power rails and snap lines."
                className={`border rounded px-2 py-1 text-sm transition-colors ${showBoardConfig
                  ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
                  : "border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
              >
                Board{boardIsCustom ? " ·" : ""}
              </button>
              {showBoardConfig && <BoardConfigPanel onClose={() => setShowBoardConfig(false)} />}
            </div>
            <div className="flex items-center gap-1.5">
              <span>Rows:</span>
              <input
                type="number"
                min={1}
                max={100}
                value={board.rows}
                readOnly={boardIsMapped}
                title={boardIsMapped
                  ? "The board map sets this. Change it under Board, or right-click a row number to insert or remove one."
                  : undefined}
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
                readOnly={boardIsMapped}
                title={boardIsMapped
                  ? "The board map sets this. Change it under Board, or right-click a column number to insert or remove one."
                  : undefined}
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
