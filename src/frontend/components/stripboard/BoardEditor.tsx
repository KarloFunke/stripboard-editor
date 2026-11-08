"use client";

import { useEffect, useRef, useState } from "react";
import { usePanZoom } from "@/hooks/usePanZoom";
import type { BoardPattern } from "@/types";
import { useProjectStore } from "@/store/useProjectStore";
import { useBoardLibraryStore } from "@/store/useBoardLibraryStore";
import { createLibraryBoard, getLibraryBoardUsage, updateLibraryBoard, type LibraryBoardUsage } from "@/lib/api";
import { boardPayload, libraryPattern } from "@/data/customBoards";
import { BUILTIN_BOARDS } from "@/data/boards";
import { copperOf, editableCopper, mapOf, patternSize, stripboardMap, type Copper } from "./boardPattern";
import {
  brushCopper, brushHoles, changeArea, clearArea, copyArea, edit, eraseCopper, fillStrips, mirrored, pasteArea, resized, rotated, setHole,
  turned, type Area, type Cell,
} from "./boardEdits";
import { confirmBoard } from "./switchBoard";
import { track } from "@/lib/track";
import { useDialogStore } from "@/lib/dialog";

const MAX_SIDE = 100;
const HISTORY = 200;
// One hole pitch in the board's drawing; the view zooms it
const PITCH = 30;

const input =
  "w-full font-sans border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 bg-white dark:bg-neutral-800 outline-none focus:border-[var(--copper)]";
const label = "block text-xs text-neutral-700 dark:text-neutral-300 mb-1";
const primary =
  "bg-[#113768] text-white text-sm px-4 py-2 rounded hover:bg-[#0d2a50] transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const secondary =
  "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 text-sm px-4 py-2 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-40";
const small =
  "px-2.5 py-1 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent";

type Tool = "copper" | "cut" | "holes" | "area";

const TOOLS: { id: Tool; name: string; hint: string }[] = [
  { id: "copper", name: "Draw copper", hint: "Paint over the board: wherever you pass between two holes, copper joins them." },
  { id: "cut", name: "Remove copper", hint: "Paint over the board: wherever you pass between two holes, the copper between them goes. Along a strip it clears the strip; down the middle between two columns it cuts every strip across that line." },
  { id: "holes", name: "Holes", hint: "Paint to take holes away, as at a mounting hole. Starting on a missing hole puts holes back. Copper stays where it is." },
  { id: "area", name: "Area", hint: "Drag out an area, then fill it with strips, clear it, or copy it (Ctrl+C). To paste (Ctrl+V), click where the copy's top left corner goes." },
];

// What was copied last, kept while the page is open, so a piece of one
// board can be put down on another
const copied: { piece: Copper | null } = { piece: null };

const hasAnyHole = (map: string[]) => map.some((line, i) => i % 2 === 0 && line.includes("o"));

interface Props {
  // The board being edited and where it lives; absent for a new board
  editing?: { pattern: BoardPattern; where: "project" | "library" };
  // What a new board starts as
  start?: string[];
  // Opened from the boards page, away from any project
  libraryOnly?: boolean;
  onClose: () => void;
}

export default function BoardEditor({ editing, start, libraryOnly = false, onClose }: Props) {
  const libraryBoards = useBoardLibraryStore((s) => s.boards);
  const upsertLibraryBoard = useBoardLibraryStore((s) => s.upsert);
  const signedIn = libraryBoards !== null;
  // The open project is on the server, so a change to the library saves it too
  const projectSaves = useProjectStore((s) => s.saveNow !== null) && !libraryOnly;

  const pattern = editing?.pattern;
  // A copy is linked only while its library board exists for this user
  const libraryId = pattern?.library && libraryBoards?.some((b) => b.id === pattern.library!.id) ? pattern.library.id : null;
  const linked = libraryId !== null && editing?.where === "project";

  const [name, setName] = useState(pattern ? (pattern.builtin ? `${pattern.name} (custom)` : pattern.name) : "My board");
  const [map, setMap] = useState<string[]>(() => pattern?.map ?? start ?? stripboardMap(20, 20));
  const [past, setPast] = useState<string[][]>([]);
  const [future, setFuture] = useState<string[][]>([]);
  const [tool, setTool] = useState<Tool>("copper");
  const [area, setArea] = useState<Area | null>(null);
  const [stripLength, setStripLength] = useState("");
  const [clip, setClip] = useState<Copper | null>(() => copied.piece);
  const { rows, cols } = patternSize(map);
  const [rowsText, setRowsText] = useState(String(rows));
  const [colsText, setColsText] = useState(String(cols));
  const [saveTo, setSaveTo] = useState<"project" | "library">(libraryOnly ? "library" : "project");
  const [alsoToLibrary, setAlsoToLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reviewing an update of a library board: the projects it reaches
  const [confirm, setConfirm] = useState<{ board: BoardPattern; usage: LibraryBoardUsage[] } | null>(null);
  // Saved in this project only after following the library: keep it as a library board too?
  const [split, setSplit] = useState<BoardPattern | null>(null);
  // A stroke in progress: where the pointer last was, and the board as it was when it started
  const drag = useRef<{
    kind: "brush" | "erase" | "holes" | "area"; from: Cell; last: Cell; startMap: string[]; map: string[]; on: boolean;
    // the copper brush acts along the way the pointer is going: where it last
    // decided, and what it decided
    turn?: Cell; way?: "across" | "down";
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoom = usePanZoom();
  const { fitTo, handlePanMove, handlePanEnd } = panZoom;
  const [view, setView] = useState<{ width: number; height: number } | null>(null);

  /** A finished change, one step for undo. */
  const commit = (next: string[], before = map) => {
    if (next.join("\n") === before.join("\n")) {
      setMap(before);
      return;
    }
    setPast((p) => [...p.slice(-HISTORY + 1), before]);
    setFuture([]);
    setMap(next);
    const size = patternSize(next);
    setRowsText(String(size.rows));
    setColsText(String(size.cols));
  };

  const undo = () => {
    if (past.length === 0) return;
    setFuture((f) => [map, ...f]);
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setMap(prev);
    setRowsText(String(patternSize(prev).rows));
    setColsText(String(patternSize(prev).cols));
  };
  const redo = () => {
    if (future.length === 0) return;
    setPast((p) => [...p, map]);
    const next = future[0];
    setFuture((f) => f.slice(1));
    setMap(next);
    setRowsText(String(patternSize(next).rows));
    setColsText(String(patternSize(next).cols));
  };

  const copy = () => {
    if (!area) return;
    copied.piece = copyArea(map, area);
    setClip(copied.piece);
  };
  // the area turned or mirrored in place; it then covers what it became
  const changeSelection = (change: (piece: Copper) => Copper) => {
    if (!area) return;
    const c = editableCopper(map);
    const placed = changeArea(c, area, change);
    commit(mapOf(c));
    setArea(placed);
  };
  // the copy goes down with its top left where the area starts, and the area
  // then covers it, ready to paste again beside it
  const paste = () => {
    if (!clip || !area) return;
    const at = { row: area.r0, col: area.c0 };
    commit(edit(map, (c) => { pasteArea(c, clip, at); }));
    setArea({ r0: at.row, c0: at.col, r1: Math.min(rows, at.row + clip.rows) - 1, c1: Math.min(cols, at.col + clip.cols) - 1 });
  };

  const changed = !pattern || !!pattern.builtin || name.trim() !== pattern.name || map.join("\n") !== pattern.map.join("\n");
  const valid = name.trim() !== "" && hasAnyHole(map);

  const cancel = () => {
    track(split ? "board-split-discard" : "board-editor-cancel");
    onClose();
  };

  // The dialog owns the keyboard, so nothing reaches the editors behind it.
  // Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      // a question asked over the editor has the keys
      if (useDialogStore.getState().queue.length > 0) return;
      e.stopPropagation();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "c" && tool === "area") {
        e.preventDefault();
        copy();
      } else if (mod && e.key.toLowerCase() === "v" && tool === "area") {
        e.preventDefault();
        paste();
      } else if (e.key === "Escape") {
        if (area) setArea(null);
        else cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ── The board drawn ───────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setView({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // The whole board in view when it opens; after that the view is the user's
  const fitted = useRef(false);
  const fit = () => view && fitTo(-PITCH * 1.6, -PITCH * 1.6, (cols + 2.2) * PITCH, (rows + 2.2) * PITCH, view.width, view.height);
  useEffect(() => {
    if (!view || fitted.current) return;
    fitted.current = true;
    fitTo(-PITCH * 1.6, -PITCH * 1.6, (cols + 2.2) * PITCH, (rows + 2.2) * PITCH, view.width, view.height);
  }, [rows, cols, view, fitTo]);

  const at = (k: number) => k * PITCH;
  const copper = copperOf(map);
  // numbers on every line when there is room, else on every fifth
  const every = panZoom.zoom * PITCH >= 16 ? 1 : 5;

  /** The pointer on the board, in holes (fractions between them). */
  const point = (e: React.MouseEvent): Cell => {
    const p = panZoom.screenToSvg(e.clientX, e.clientY, svgRef.current!);
    return { row: p.y / PITCH, col: p.x / PITCH };
  };
  const nearest = ({ row, col }: Cell): Cell => ({
    row: Math.max(0, Math.min(rows - 1, Math.round(row))),
    col: Math.max(0, Math.min(cols - 1, Math.round(col))),
  });

  const onDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      panZoom.handlePanStart(e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    // a size typed into the fields counts before the board is touched
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = point(e);
    if (tool === "copper") {
      drag.current = { kind: "brush", from: p, last: p, startMap: map, map, on: true, turn: p };
    } else if (tool === "cut") {
      const next = edit(map, (cu) => eraseCopper(cu, p, p));
      drag.current = { kind: "erase", from: p, last: p, startMap: map, map: next, on: false };
      setMap(next);
    } else if (tool === "holes") {
      const cell = nearest(p);
      const on = !copper.hole[cell.row * cols + cell.col];
      const next = edit(map, (cu) => brushHoles(cu, p, p, on));
      drag.current = { kind: "holes", from: p, last: p, startMap: map, map: next, on };
      setMap(next);
    } else {
      const cell = nearest(p);
      drag.current = { kind: "area", from: cell, last: cell, startMap: map, map, on: true };
      setArea({ r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col });
    }
  };

  const onMove = (e: React.MouseEvent) => {
    if (handlePanMove(e)) return;
    const d = drag.current;
    if (!d) return;
    // the button came up outside the dialog
    if ((e.buttons & 1) === 0) {
      onUp();
      return;
    }
    const p = point(e);
    // the stroke so far lives with the stroke, so a move that comes before
    // the last one was drawn still builds on it
    if (d.kind === "brush") {
      // which way it goes, judged over a stretch of the stroke so a wobble
      // does not turn it; until then nothing is painted, then all of it
      const turn = d.turn ?? p;
      if (Math.hypot(p.row - turn.row, p.col - turn.col) >= 0.35) {
        const from = d.way ? d.last : d.from;
        d.way = Math.abs(p.row - turn.row) > Math.abs(p.col - turn.col) ? "down" : "across";
        d.turn = p;
        d.last = from;
      }
      if (d.way) {
        const way = d.way;
        d.map = edit(d.map, (cu) => brushCopper(cu, d.last, p, d.on, way));
        setMap(d.map);
      }
    } else if (d.kind === "erase") {
      d.map = edit(d.map, (cu) => eraseCopper(cu, d.last, p));
      setMap(d.map);
    } else if (d.kind === "holes") {
      d.map = edit(d.map, (cu) => brushHoles(cu, d.last, p, d.on));
      setMap(d.map);
    } else {
      const cell = nearest(p);
      setArea({
        r0: Math.min(d.from.row, cell.row), c0: Math.min(d.from.col, cell.col),
        r1: Math.max(d.from.row, cell.row), c1: Math.max(d.from.col, cell.col),
      });
    }
    d.last = p;
  };

  const onUp = () => {
    handlePanEnd();
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind === "area") return;
    // a click that never became a stroke acts between the two places it is nearest
    if (d.kind === "brush" && !d.way) d.map = edit(d.map, (cu) => brushCopper(cu, d.from, d.from, d.on));
    commit(d.map, d.startMap);
  };

  const holeDots: React.ReactNode[] = [];
  const runs: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (copper.right[i] && !(c > 0 && copper.right[i - 1])) {
        let end = c + 1;
        while (copper.right[r * cols + end]) end++;
        runs.push(<rect key={`r${i}`} x={at(c) - PITCH * 0.32} y={at(r) - PITCH * 0.2} width={at(end) - at(c) + PITCH * 0.64} height={PITCH * 0.4} rx={PITCH * 0.08} />);
      }
      if (copper.down[i] && !(r > 0 && copper.down[i - cols])) {
        let end = r + 1;
        while (copper.down[end * cols + c]) end++;
        runs.push(<rect key={`d${i}`} x={at(c) - PITCH * 0.2} y={at(r) - PITCH * 0.32} width={PITCH * 0.4} height={at(end) - at(r) + PITCH * 0.64} rx={PITCH * 0.08} />);
      }
      holeDots.push(copper.hole[i]
        ? <circle key={`h${i}`} cx={at(c)} cy={at(r)} r={PITCH * 0.16} fill="var(--hole-fill)" stroke="var(--hole-stroke)" strokeWidth={0.8} />
        : <circle key={`h${i}`} cx={at(c)} cy={at(r)} r={PITCH * 0.06} fill="var(--label-text)" opacity={0.35} />);
    }
  }

  // ── Saving ────────────────────────────────────────────

  const design = (): BoardPattern => ({ name: name.trim(), map });
  const shape = () => ({ rows, cols, edit: editing ? "update" : "new" });

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
    setBusy(false);
  }

  /** A new library board made from this one, which the project's copy then follows. */
  async function addToLibrary(board: BoardPattern): Promise<BoardPattern> {
    const created = await createLibraryBoard(boardPayload(board));
    upsertLibraryBoard(created);
    return libraryPattern(created);
  }

  /** After a change to the library the open project is saved too, so the server never holds a library board without the project's link to it. */
  async function saveProjectToo() {
    if (!libraryOnly) await useProjectStore.getState().saveNow?.();
  }

  const putOnProject = (board: BoardPattern) => useProjectStore.getState().setBoardPattern(board);

  /** On this project only; a board that followed the library stops following it. */
  const saveInProject = () => run(async () => {
    let board = design();
    if (!(await confirmBoard(board))) return;
    const toLibrary = !linked && signedIn && (editing ? alsoToLibrary : saveTo === "library");
    if (toLibrary) board = await addToLibrary(board);
    putOnProject(board);
    if (toLibrary) await saveProjectToo();
    track("board-save", { ...shape(), target: toLibrary ? "project+library" : "project" });
    if (linked) setSplit(board);
    else onClose();
  });

  const keepSplitInLibrary = () => run(async () => {
    putOnProject(await addToLibrary(split!));
    await saveProjectToo();
    track("board-split-keep");
    onClose();
  });

  const saveNewToLibrary = () => run(async () => {
    upsertLibraryBoard(await createLibraryBoard(boardPayload(design())));
    track("board-save", { ...shape(), target: "library" });
    onClose();
  });

  /** First step of updating a library board: show which projects it reaches. */
  const reviewLibraryUpdate = () => run(async () => {
    setConfirm({ board: design(), usage: await getLibraryBoardUsage(libraryId ?? pattern!.library!.id) });
  });

  const updateLibrary = () => run(async () => {
    if (!libraryOnly && !(await confirmBoard(confirm!.board))) return;
    const saved = await updateLibraryBoard(libraryId ?? pattern!.library!.id, boardPayload(confirm!.board), {
      updateProjects: true, skipBranch: libraryOnly ? undefined : useProjectStore.getState().branchId ?? undefined,
    });
    track("board-library-update", { ...shape(), projects: confirm!.usage.length });
    upsertLibraryBoard(saved);
    if (!libraryOnly) putOnProject(libraryPattern(saved));
    await saveProjectToo();
    onClose();
  });

  const startOptions = [
    { key: "blank", label: "Holes without copper", map: () => edit(stripboardMap(rows, cols), (c) => c.right.fill(0)) },
    { key: "stripboard", label: "Stripboard", map: () => stripboardMap(rows, cols) },
    ...BUILTIN_BOARDS.map((b) => ({ key: b.id, label: b.name, map: () => b.map })),
    ...(libraryBoards ?? []).map((b) => ({ key: b.id, label: b.board.name, map: () => b.board.map })),
  ];
  const len = Math.max(0, Math.floor(Number(stripLength) || 0));
  const applySize = (rowsValue = rowsText, colsValue = colsText) => {
    const r = Math.max(1, Math.min(MAX_SIDE, Math.floor(Number(rowsValue) || rows)));
    const c = Math.max(1, Math.min(MAX_SIDE, Math.floor(Number(colsValue) || cols)));
    setRowsText(String(r));
    setColsText(String(c));
    if (r !== rows || c !== cols) {
      setArea(null);
      commit(resized(map, r, c));
    }
  };
  const onArea = (change: (c: Copper, a: Area) => void) => area && commit(edit(map, (c) => change(c, area)));
  const title = pattern ? `Edit ${pattern.name}` : "New board";
  const hint = TOOLS.find((t) => t.id === tool)!.hint;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-3" onMouseUp={onUp}>
      <div
        className="font-sans bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-5 w-full h-full max-w-[1800px] flex flex-col overflow-hidden select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="font-mono text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
          <button
            onClick={cancel}
            aria-label="Close"
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {split ? (
          <div className="max-w-xl">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              Saved on this project only. {split.name} here no longer follows your library, and your library board stays as it was.
            </p>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-5">
              Keep this version as a new board in your library too?{projectSaves && " This also saves the project."}
            </p>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex gap-2 font-mono">
              <button onClick={keepSplitInLibrary} disabled={busy} className={primary}>Add to my library</button>
              <button onClick={cancel} disabled={busy} className={secondary}>No, done</button>
            </div>
          </div>
        ) : confirm ? (
          <div className="max-w-xl">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              {confirm.usage.length === 0
                ? "No project is on this board yet. Only your library changes."
                : `This updates the board in your library and in ${confirm.usage.length > 1 ? `these ${confirm.usage.length} projects` : "one project"}:`}
            </p>
            {confirm.usage.length > 0 && (
              <ul className="text-sm text-neutral-700 dark:text-neutral-300 mb-3 max-h-60 overflow-auto border border-neutral-200 dark:border-neutral-700 rounded divide-y divide-neutral-200 dark:divide-neutral-700">
                {confirm.usage.map((u) => (
                  <li key={u.edit_uuid} className="px-3 py-1.5 flex gap-2">
                    <span className="truncate">{u.name}</span>
                    {u.placed > 0 && <span className="ml-auto shrink-0 text-neutral-500">{u.placed} placed</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-5">
              Projects whose board you changed on its own are not touched. Parts, wires and cuts that lose their holes or copper come off the board when a project is next opened.{projectSaves && " This project is saved along with it."}
            </p>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex gap-2 font-mono">
              <button onClick={updateLibrary} disabled={busy} className={primary}>Update everywhere</button>
              <button onClick={() => setConfirm(null)} disabled={busy} className={secondary}>Back</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 min-h-0 grid gap-5 grid-cols-[250px_1fr] grid-rows-[minmax(0,1fr)]">
              {/* What the board is, and the tools */}
              <div className="space-y-4 overflow-y-auto pr-1">
                <div>
                  <label className={label}>Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={input} />
                </div>
                {!pattern && (
                  <div>
                    <label className={label}>Start from</label>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const option = startOptions.find((o) => o.key === e.target.value);
                        if (option) commit(option.map());
                        e.target.value = "";
                      }}
                      className={input}
                    >
                      <option value="" disabled>Pick a board to start from</option>
                      {startOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <div className="w-20">
                    <label className={label}>Rows</label>
                    <input
                      type="number" min={1} max={MAX_SIDE} value={rowsText}
                      onChange={(e) => {
                        setRowsText(e.target.value);
                        if (Math.abs(Number(e.target.value) - rows) === 1) applySize(e.target.value, colsText);
                      }}
                      onBlur={() => applySize()}
                      onKeyDown={(e) => e.key === "Enter" && applySize()}
                      className={`${input} text-center`}
                    />
                  </div>
                  <div className="w-20">
                    <label className={label}>Columns</label>
                    <input
                      type="number" min={1} max={MAX_SIDE} value={colsText}
                      onChange={(e) => {
                        setColsText(e.target.value);
                        if (Math.abs(Number(e.target.value) - cols) === 1) applySize(rowsText, e.target.value);
                      }}
                      onBlur={() => applySize()}
                      onKeyDown={(e) => e.key === "Enter" && applySize()}
                      className={`${input} text-center`}
                    />
                  </div>
                </div>
                <div>
                  <span className={label}>Whole board</span>
                  <div className="flex flex-wrap gap-1">
                    <button onClick={() => { setArea(null); commit(rotated(map)); }} className={small} title="Turn the board a quarter clockwise">Rotate</button>
                    <button onClick={() => commit(mapOf(mirrored(copperOf(map), "across")))} className={small} title="Mirror the board left to right">Mirror ↔</button>
                    <button onClick={() => commit(mapOf(mirrored(copperOf(map), "down")))} className={small} title="Mirror the board top to bottom">Mirror ↕</button>
                  </div>
                </div>

                <div>
                  <span className={label}>Tool</span>
                  <div className="grid grid-cols-2 gap-1">
                    {TOOLS.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setTool(t.id);
                          if (t.id !== "area") setArea(null);
                        }}
                        title={t.hint}
                        className={`px-2 py-1.5 text-sm rounded ${tool === t.id
                          ? "bg-[#113768] text-white"
                          : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5">{hint}</p>
                </div>

                {tool === "area" && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                      <span>Strips of</span>
                      <input
                        type="number" min={0} value={stripLength} placeholder="all"
                        onChange={(e) => setStripLength(e.target.value)}
                        className={`${input} w-16 text-center`}
                      />
                      <span>holes</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button disabled={!area} onClick={() => onArea((c, a) => fillStrips(c, a, false, len))} className={small}>Strips across</button>
                      <button disabled={!area} onClick={() => onArea((c, a) => fillStrips(c, a, true, len))} className={small}>Strips down</button>
                      <button disabled={!area} onClick={() => onArea(clearArea)} className={small}>No copper</button>
                      <button
                        disabled={!area}
                        onClick={() => onArea((c, a) => { for (let r = a.r0; r <= a.r1; r++) for (let col = a.c0; col <= a.c1; col++) setHole(c, { row: r, col }, false); })}
                        className={small}
                      >
                        No holes
                      </button>
                      <button
                        disabled={!area}
                        onClick={() => onArea((c, a) => { for (let r = a.r0; r <= a.r1; r++) for (let col = a.c0; col <= a.c1; col++) setHole(c, { row: r, col }, true); })}
                        className={small}
                      >
                        Holes
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <button disabled={!area} onClick={() => changeSelection(turned)} className={small} title="Turn the area a quarter clockwise about its middle">Rotate</button>
                      <button disabled={!area} onClick={() => changeSelection((p) => mirrored(p, "across"))} className={small} title="Mirror the area left to right">Mirror ↔</button>
                      <button disabled={!area} onClick={() => changeSelection((p) => mirrored(p, "down"))} className={small} title="Mirror the area top to bottom">Mirror ↕</button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <button disabled={!area} onClick={copy} className={small} title="Copy the area's holes and copper (Ctrl+C)">Copy</button>
                      <button disabled={!area || !clip} onClick={paste} className={small} title="Put the copy down with its top left where the area starts (Ctrl+V)">Paste</button>
                      {clip && <span className="text-xs text-neutral-500 dark:text-neutral-400">{clip.rows} x {clip.cols} copied</span>}
                    </div>
                  </div>
                )}

                <div className="flex gap-1">
                  <button onClick={undo} disabled={past.length === 0} className={small} title="Undo (Ctrl+Z)">Undo</button>
                  <button onClick={redo} disabled={future.length === 0} className={small} title="Redo (Ctrl+Shift+Z)">Redo</button>
                </div>
              </div>

              {/* The board: scroll to zoom, the right button moves it */}
              <div ref={containerRef} className="relative min-h-[300px] overflow-hidden rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950">
                {view && (
                  <svg
                    ref={svgRef}
                    width={view.width}
                    height={view.height}
                    viewBox={panZoom.getViewBox(view.width, view.height)}
                    className="block"
                    style={{ cursor: panZoom.panning ? "grabbing" : "crosshair" }}
                    onMouseDown={onDown}
                    onMouseMove={onMove}
                    onWheel={panZoom.handleWheel}
                    onContextMenu={panZoom.handleContextMenu}
                  >
                    <rect x={-PITCH * 0.6} y={-PITCH * 0.6} width={at(cols - 1) + PITCH * 1.2} height={at(rows - 1) + PITCH * 1.2}
                      rx={4} fill="var(--board-fill)" stroke="var(--board-edge)" />
                    {Array.from({ length: cols }, (_, c) => (c === 0 || (c + 1) % every === 0) && (
                      <text key={`cl${c}`} x={at(c)} y={-PITCH * 0.95} textAnchor="middle" fontSize={11} fill="var(--label-text)">{c + 1}</text>
                    ))}
                    {Array.from({ length: rows }, (_, r) => (r === 0 || (r + 1) % every === 0) && (
                      <text key={`rl${r}`} x={-PITCH * 0.9} y={at(r)} textAnchor="end" dominantBaseline="central" fontSize={11} fill="var(--label-text)">{r + 1}</text>
                    ))}
                    <g fill="var(--strip-color)">{runs}</g>
                    {holeDots}
                    {/* where a paste would land */}
                    {tool === "area" && clip && area && (
                      <rect
                        x={at(area.c0) - PITCH / 2} y={at(area.r0) - PITCH / 2}
                        width={(Math.min(cols, area.c0 + clip.cols) - area.c0) * PITCH} height={(Math.min(rows, area.r0 + clip.rows) - area.r0) * PITCH}
                        fill="none" stroke="var(--copper)" strokeWidth={1.5} strokeDasharray="2 4" pointerEvents="none"
                      />
                    )}
                    {area && (
                      <rect
                        x={at(area.c0) - PITCH / 2} y={at(area.r0) - PITCH / 2}
                        width={(area.c1 - area.c0 + 1) * PITCH} height={(area.r1 - area.r0 + 1) * PITCH}
                        fill="var(--selection-stroke)" fillOpacity={0.12} stroke="var(--selection-stroke)" strokeDasharray="4 3" pointerEvents="none"
                      />
                    )}
                  </svg>
                )}
                <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-white/90 dark:bg-neutral-800/90 border border-neutral-200 dark:border-neutral-700 rounded-md px-1.5 py-1 shadow-sm dark:shadow-neutral-900/30 text-xs text-neutral-600 dark:text-neutral-400">
                  <button onClick={fit} className="px-1.5 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded transition-colors" title="Show the whole board. Scroll to zoom, drag with the right button to move.">
                    {Math.round(panZoom.zoom * 100)}%
                  </button>
                </div>
              </div>
            </div>

            {/* Where it goes */}
            <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 flex flex-wrap items-center gap-3 shrink-0">
              {!pattern && !libraryOnly && (
                <div className="flex items-center gap-4 text-sm text-neutral-700 dark:text-neutral-300">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={saveTo === "project"} onChange={() => setSaveTo("project")} />
                    This project
                  </label>
                  <label className={`flex items-center gap-1.5 ${signedIn ? "" : "opacity-50"}`} title={signedIn ? undefined : "Log in to keep boards for all your projects"}>
                    <input type="radio" checked={saveTo === "library"} onChange={() => setSaveTo("library")} disabled={!signedIn} />
                    My library (all my projects)
                  </label>
                </div>
              )}
              {pattern && editing?.where === "project" && signedIn && !linked && (
                <label className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                  <input type="checkbox" checked={alsoToLibrary} onChange={(e) => setAlsoToLibrary(e.target.checked)} />
                  Also save it to my library
                </label>
              )}
              {error && <span className="text-sm text-red-600">{error}</span>}
              {!changed && !alsoToLibrary && <span className="text-sm text-neutral-500 dark:text-neutral-400">No changes yet</span>}
              {projectSaves && (linked || alsoToLibrary || (!pattern && saveTo === "library")) && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">Changes to your library also save this project.</span>
              )}

              <div className="ml-auto flex flex-wrap justify-end gap-2 font-mono">
                {!pattern && (
                  <button onClick={libraryOnly ? saveNewToLibrary : saveInProject} disabled={!valid || busy} className={primary}>
                    {libraryOnly ? "Create board" : "Use this board"}
                  </button>
                )}
                {pattern && linked && (
                  <button onClick={reviewLibraryUpdate} disabled={!valid || !changed || busy} className={primary} title="Change the board in your library and in every project on it">
                    Update board in library and all projects…
                  </button>
                )}
                {pattern && editing?.where === "project" && (
                  <button
                    onClick={saveInProject}
                    disabled={!valid || !(changed || alsoToLibrary) || busy}
                    className={linked ? secondary : primary}
                    title={linked ? "Change it here only; it stops following the library" : undefined}
                  >
                    {linked ? "Update board in this project only" : pattern.builtin ? "Save as custom board" : "Save"}
                  </button>
                )}
                {pattern && editing?.where === "library" && (
                  <button onClick={reviewLibraryUpdate} disabled={!valid || !changed || busy} className={primary}>
                    Save…
                  </button>
                )}
                <button onClick={cancel} className={secondary}>Cancel</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
