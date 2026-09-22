"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { PinDef, BodyCell, ComponentDef, Footprint, PartSpec } from "@/types";
import { createFootprintSymbol, registerCustomSymbol } from "@/data/symbolDefs";
import { COMPONENT_GROUP_LABELS, partDef } from "@/data/defaultComponents";
import { libraryDef, libraryPayload, newCustomId } from "@/data/customParts";
import { createLibraryPart, getLibraryPartUsage, updateLibraryPart, type LibraryPartUsage } from "@/lib/api";
import { useProjectStore } from "@/store/useProjectStore";
import { useLibraryStore } from "@/store/useLibraryStore";
import SymbolRenderer from "./SymbolRenderer";

type CellState = "body" | { pinId: string; pinName: string };
type Cell = { row: number; col: number };
const cellOf = (key: string): Cell => {
  const [row, col] = key.split(",").map(Number);
  return { row, col };
};

const CELL_SIZE = 30;
const CELL_GAP = 2;
const GRID_PADDING = 10;

// Parts made from a body: which generic body, and how many pins it has
type BodyKind = "dip" | "sip" | "to" | "opamp";
const BODIES: { kind: BodyKind; label: string }[] = [
  { kind: "dip", label: "IC, two rows (DIP)" },
  { kind: "sip", label: "IC, one row (SIP)" },
  { kind: "to", label: "Three legs (TO-92 / TO-220)" },
  { kind: "opamp", label: "Single op amp (triangle)" },
];
const DIP_COUNTS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40];
const OPAMP_NAMES = ["NULL", "IN−", "IN+", "V−", "NULL", "OUT", "V+", "NC"];
type Side = "l" | "r" | "t" | "b";
const SIDE_LABELS: Record<Side, string> = { l: "Left", r: "Right", t: "Top", b: "Bottom" };
const PREVIEW_ID = "editor-preview";

const input =
  "w-full font-sans border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 bg-white dark:bg-neutral-800 outline-none focus:border-[var(--copper)]";
const label = "block text-xs text-neutral-700 dark:text-neutral-300 mb-1";
const primary =
  "bg-[#113768] text-white text-sm px-4 py-2 rounded hover:bg-[#0d2a50] transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const secondary =
  "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 text-sm px-4 py-2 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-40";

interface Props {
  // The part being edited: a copy in this project or a part of the user's
  // library. Absent for a new part.
  editing?: { def: ComponentDef; where: "project" | "library" };
  // Outside a project (the parts page): a new part goes to the library
  libraryOnly?: boolean;
  // A new part's name to start with
  initialName?: string;
  onClose: () => void;
}

function gridFrom(def: ComponentDef): CellState[][] {
  const grid: CellState[][] = Array.from({ length: def.height }, () => Array.from({ length: def.width }, () => "body" as CellState));
  for (const p of def.pins) grid[p.offsetRow][p.offsetCol] = { pinId: p.id, pinName: p.name };
  return grid;
}

/** What the editor can change about a part, in a form that compares equal when nothing was changed. */
function editedFields(def: ComponentDef): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]))
    : v;
  const byKey = <T,>(items: T[], key: (t: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)));
  return JSON.stringify(sorted({
    name: def.name,
    prefix: def.defaultLabelPrefix,
    group: def.group ?? "",
    description: def.description ?? "",
    width: def.width,
    height: def.height,
    pins: byKey(def.pins, (p) => p.id).map((p) => [p.id, p.name, p.offsetRow, p.offsetCol]),
    bodyCells: byKey(def.bodyCells ?? [], (c) => `${c.row},${c.col}`),
    symbol: def.symbol,
    // The spec keeps the id it was built under, which a library copy rewrites
    spec: def.spec ? { ...def.spec, id: "" } : null,
  }));
}

function bodyKindOf(spec: PartSpec): BodyKind {
  if (spec.symbol === "opamp") return "opamp";
  if (spec.footprint.kind === "to") return "to";
  if (spec.footprint.kind === "inline") return "sip";
  return "dip";
}

function sidesOf(spec: PartSpec | undefined): Side[] {
  const m = spec?.symbol?.match(/^box-(.*)$/);
  if (!m) return ["l", "b", "r"];
  const sides: Side[] = ["l", "b", "r"];
  for (const token of m[1].split("-")) sides[Number(token.slice(1)) - 1] = token[0] as Side;
  return sides;
}

export default function CustomComponentEditor({ editing, libraryOnly = false, initialName, onClose }: Props) {
  const params = useParams();
  // The project open in the editor, when it has been saved
  const editUuid = typeof params?.editUuid === "string" ? params.editUuid : undefined;
  const addComponentDef = useProjectStore((s) => s.addComponentDef);
  const replaceComponentDef = useProjectStore((s) => s.replaceComponentDef);
  const applyLibraryUpdate = useProjectStore((s) => s.applyLibraryUpdate);
  const libraryParts = useLibraryStore((s) => s.parts);
  const upsertLibraryPart = useLibraryStore((s) => s.upsert);
  const signedIn = libraryParts !== null;
  // The open project is on the server, so a change to the library saves it too
  const projectSaves = useProjectStore((s) => s.saveNow !== null) && !libraryOnly;

  const def = editing?.def;
  const spec = def?.spec;
  // A copy is linked only while its library part exists for this user; a
  // copy that came with someone else's project is edited as a plain part
  const libraryId = def?.library && libraryParts?.some((p) => p.id === def.library!.id) ? def.library.id : null;
  // Inside a project, a library part not yet copied here is offered the same
  // choices as a linked copy
  const linked = libraryId !== null && (editing?.where === "project" || !libraryOnly);

  const [mode, setMode] = useState<"body" | "grid">(def && !spec ? "grid" : "body");
  const [name, setName] = useState(def?.name ?? initialName ?? "Custom Part");
  const [prefix, setPrefix] = useState(def?.defaultLabelPrefix ?? "U");
  const [group, setGroup] = useState(def?.group ?? "");
  const [description, setDescription] = useState(def?.description ?? "");
  const [saveTo, setSaveTo] = useState<"project" | "library">(libraryOnly ? "library" : "project");
  const [alsoToLibrary, setAlsoToLibrary] = useState(false);
  // A copy just split off from the library, which may be kept as a library part of its own
  const [split, setSplit] = useState<ComponentDef | null>(null);

  // Grid mode
  const [grid, setGrid] = useState<CellState[][]>(
    def && !spec ? gridFrom(def) : [["body", "body"], ["body", "body"]],
  );
  // A new pin being named at this cell
  const [editingPin, setEditingPin] = useState<{ row: number; col: number } | null>(null);
  const [pinId, setPinId] = useState("");
  const [pinName, setPinName] = useState("");
  // Selected pins, as "row,col"; a drag moves all of them
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ from: Cell; to: Cell } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Body mode
  const [bodyKind, setBodyKind] = useState<BodyKind>(spec ? bodyKindOf(spec) : "dip");
  const [names, setNames] = useState<string[]>(
    spec?.pins ?? Array.from({ length: 8 }, (_, i) => String(i + 1)),
  );
  const [sides, setSides] = useState<Side[]>(sidesOf(spec));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ part: ComponentDef; usage: LibraryPartUsage[] } | null>(null);

  // The preview zooms to whatever was drawn, pin names included
  const previewRef = useRef<SVGGElement>(null);
  const [previewBox, setPreviewBox] = useState("-100 -80 200 160");
  useLayoutEffect(() => {
    const b = previewRef.current?.getBBox();
    if (!b) return;
    const w = Math.max(b.width + 24, 200);
    const h = Math.max(b.height + 24, 160);
    const box = `${b.x + b.width / 2 - w / 2} ${b.y + b.height / 2 - h / 2} ${w} ${h}`;
    setPreviewBox((prev) => (prev === box ? prev : box));
  });

  const rows = grid.length;
  const cols = grid[0]?.length ?? 1;
  const gridPins: PinDef[] = [];
  const gridBody: BodyCell[] = [];
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (typeof cell === "object") gridPins.push({ id: cell.pinId, name: cell.pinName, offsetRow: r, offsetCol: c });
    else gridBody.push({ row: r, col: c });
  }));

  // ── Grid editing ──────────────────────────────────────

  const getNextPinNumber = (): number => {
    let max = 0;
    for (const p of gridPins) {
      const num = parseInt(p.id, 10);
      if (!isNaN(num) && num > max) max = num;
    }
    return max + 1;
  };

  const select = (keys: string[]) => {
    setSelected(new Set(keys));
    setConfirmRemove(false);
    const only = keys.length === 1 ? cellOf(keys[0]) : null;
    const cell = only && grid[only.row][only.col];
    if (cell && typeof cell === "object") {
      setPinId(cell.pinId);
      setPinName(cell.pinName);
    }
  };

  // Where the selection would land, or null when a pin would leave the grid
  // or land on a pin that stays
  function moveTargets(from: Cell, to: Cell): Map<string, string> | null {
    const dr = to.row - from.row;
    const dc = to.col - from.col;
    const out = new Map<string, string>();
    for (const key of selected) {
      const { row, col } = cellOf(key);
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
      const target = `${r},${c}`;
      if (typeof grid[r][c] === "object" && !selected.has(target) && selected.size > 1) return null;
      out.set(key, target);
    }
    return out;
  }

  const handleCellMouseDown = (e: React.MouseEvent, row: number, col: number) => {
    const cell = grid[row][col];
    if (typeof cell !== "object") return;
    const key = `${row},${col}`;
    setEditingPin(null);
    if (e.shiftKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      select([...next]);
      return;
    }
    if (!selected.has(key)) select([key]);
    setDrag({ from: { row, col }, to: { row, col } });
  };

  const finishDrag = () => {
    if (!drag) return;
    const targets = moveTargets(drag.from, drag.to);
    setDrag(null);
    if (!targets || (drag.from.row === drag.to.row && drag.from.col === drag.to.col)) return;
    const newGrid = grid.map((r) => [...r]);
    const moving = [...targets.keys()].map((key) => {
      const { row, col } = cellOf(key);
      return { cell: grid[row][col], target: cellOf(targets.get(key)!) };
    });
    // One pin dropped on another swaps the two
    if (moving.length === 1) {
      const { row, col } = cellOf([...targets.keys()][0]);
      const t = moving[0].target;
      newGrid[row][col] = grid[t.row][t.col];
    } else {
      for (const key of targets.keys()) {
        const { row, col } = cellOf(key);
        newGrid[row][col] = "body";
      }
    }
    for (const m of moving) newGrid[m.target.row][m.target.col] = m.cell;
    setGrid(newGrid);
    setSelected(new Set(targets.values()));
  };

  // A click on the body starts a new pin there
  const handleCellClick = (row: number, col: number) => {
    if (typeof grid[row][col] === "object") return;
    select([]);
    const nextNum = getNextPinNumber();
    setPinId(String(nextNum));
    setPinName(String(nextNum));
    setEditingPin({ row, col });
  };

  // Names the new pin, or renames the one selected pin
  const commitPin = () => {
    const at = editingPin ?? (selected.size === 1 ? cellOf([...selected][0]) : null);
    if (!at || !pinId.trim()) {
      setEditingPin(null);
      return;
    }
    const newGrid = grid.map((r) => [...r]);
    newGrid[at.row][at.col] = { pinId: pinId.trim(), pinName: pinName.trim() || pinId.trim() };
    setGrid(newGrid);
    setEditingPin(null);
  };

  const removeSelected = () => {
    const newGrid = grid.map((r) => [...r]);
    for (const key of selected) {
      const { row, col } = cellOf(key);
      newGrid[row][col] = "body";
    }
    setGrid(newGrid);
    select([]);
  };

  const addRow = () => setGrid([...grid, Array.from({ length: cols }, () => "body" as CellState)]);
  const removeRow = () => {
    if (rows <= 1) return;
    if (grid[rows - 1].some((c) => typeof c === "object")) return;
    setGrid(grid.slice(0, -1));
  };
  const addCol = () => setGrid(grid.map((row) => [...row, "body" as CellState]));
  const removeCol = () => {
    if (cols <= 1) return;
    if (grid.some((row) => typeof row[cols - 1] === "object")) return;
    setGrid(grid.map((row) => row.slice(0, -1)));
  };

  // The dialog owns the keyboard: Delete, Escape and the editors' own shortcuts
  // never reach the canvases behind it. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      e.stopPropagation();
      if (mode !== "grid") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        if (confirmRemove) removeSelected();
        else setConfirmRemove(true);
      } else if (e.key === "Enter" && confirmRemove) {
        e.preventDefault();
        removeSelected();
      } else if (e.key === "Escape") {
        if (confirmRemove) setConfirmRemove(false);
        else if (editingPin) setEditingPin(null);
        else select([]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ── Body editing ──────────────────────────────────────

  const resize = (count: number) =>
    setNames((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? String(i + 1)));

  const chooseBody = (kind: BodyKind) => {
    setBodyKind(kind);
    // The op amp's names only make sense on the op amp; untouched, they go
    if (bodyKind === "opamp" && names.join() === OPAMP_NAMES.join()) setNames(names.map((_, i) => String(i + 1)));
    if (kind === "opamp") setNames(OPAMP_NAMES);
    else if (kind === "to") resize(3);
    else if (kind === "dip" && names.length % 2 === 1) resize(names.length + 1);
  };

  const sidesTaken = new Set(sides).size === sides.length;

  // One pin's name, its number on the side facing away from the body
  const pinField = (i: number, numberSide: "left" | "right") => (
    <div key={i} className={`flex items-center gap-2 ${numberSide === "right" ? "flex-row-reverse" : ""}`}>
      <span className={`w-6 font-mono text-xs text-neutral-500 ${numberSide === "right" ? "text-left" : "text-right"}`}>{i + 1}</span>
      <input
        value={names[i]}
        onChange={(e) => setNames(names.map((m, j) => (j === i ? e.target.value : m)))}
        aria-label={`Pin ${i + 1} name`}
        className={`${input} w-40`}
      />
    </div>
  );

  function bodySpec(id: string): PartSpec {
    let footprint: Footprint = { kind: "dip", pins: names.length };
    let symbol: string | undefined;
    if (bodyKind === "sip") {
      footprint = { kind: "inline", pins: names.length };
      symbol = `sip-ic-${names.length}`;
    } else if (bodyKind === "to") {
      footprint = { kind: "to" };
      symbol = `box-${sides.map((side, i) => `${side}${i + 1}`).join("-")}`;
    } else if (bodyKind === "opamp") {
      symbol = "opamp";
    }
    return {
      id,
      name: name.trim(),
      group,
      category: "ic",
      labelPrefix: prefix.trim() || "U",
      ...(description.trim() ? { description: description.trim() } : {}),
      footprint,
      pins: names.map((n, i) => n.trim() || String(i + 1)),
      ...(symbol ? { symbol } : {}),
    };
  }

  // ── The part ──────────────────────────────────────────

  function buildDef(id: string): ComponentDef {
    const extra = {
      ...(group ? { group } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    if (mode === "body") {
      const s = bodySpec(id);
      return { ...partDef(s), ...extra, spec: s };
    }
    return {
      id,
      name: name.trim(),
      category: "generic",
      symbol: `custom-footprint-${id}`,
      defaultLabelPrefix: prefix.trim() || "U",
      width: cols,
      height: rows,
      pins: gridPins,
      bodyCells: gridBody.length > 0 ? gridBody : undefined,
      ...extra,
    };
  }

  const valid = name.trim() !== "" && (mode === "grid" ? gridPins.length > 0 : bodyKind !== "to" || sidesTaken);
  // Saving an untouched part would only make a duplicate or a pointless update
  const changed = !def || editedFields(buildDef(def.id)) !== editedFields(def);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  /** A new library part made from this project's part, which then links to it. */
  async function addToLibrary(part: ComponentDef): Promise<ComponentDef> {
    const created = await createLibraryPart(libraryPayload(part));
    upsertLibraryPart(created);
    return { ...part, library: { id: created.id, rev: created.rev } };
  }

  /**
   * After a change to the library, the open project is saved too, so the
   * server never holds a library part without the project's link to it.
   * A failed save shows in the toolbar like any other.
   */
  async function saveProjectToo() {
    if (!libraryOnly) await useProjectStore.getState().saveNow?.();
  }

  /** Saves a part in this project only; a part that followed the library stops following it. */
  const saveInProject = () => run(async () => {
    const inProject = def && editing?.where === "project";
    let part = buildDef(inProject ? def.id : newCustomId());
    const toLibrary = !linked && def && alsoToLibrary && signedIn;
    if (toLibrary) part = await addToLibrary(part);
    if (inProject) replaceComponentDef(part);
    else addComponentDef(part);
    if (toLibrary) await saveProjectToo();
    if (linked) setSplit(part);
    else onClose();
  });

  const keepSplitInLibrary = () => run(async () => {
    replaceComponentDef(await addToLibrary(split!));
    await saveProjectToo();
    onClose();
  });

  const saveNewToLibrary = () => run(async () => {
    const created = await createLibraryPart(libraryPayload(buildDef(newCustomId())));
    upsertLibraryPart(created);
    await saveProjectToo();
    onClose();
  });

  /** First step of updating a library part: show which projects it reaches. */
  const reviewLibraryUpdate = () => run(async () => {
    const usage = await getLibraryPartUsage(libraryId ?? def!.library!.id);
    setConfirm({ part: buildDef(def!.id), usage });
  });

  const updateLibrary = () => run(async () => {
    const id = libraryId ?? def!.library!.id;
    const saved = await updateLibraryPart(id, libraryPayload(confirm!.part), { updateProjects: true, skipProject: editUuid });
    upsertLibraryPart(saved);
    if (!libraryOnly) applyLibraryUpdate(libraryDef(saved));
    await saveProjectToo();
    onClose();
  });

  // ── Preview ───────────────────────────────────────────

  let previewSymbol: string;
  const previewNames: Record<string, string> = {};
  if (mode === "grid") {
    previewSymbol = `custom-footprint-${PREVIEW_ID}`;
    registerCustomSymbol(PREVIEW_ID, { ...createFootprintSymbol(gridPins, cols, rows), symbolId: previewSymbol });
    for (const p of gridPins) previewNames[p.id] = p.name;
  } else {
    const preview = partDef(bodySpec(PREVIEW_ID));
    previewSymbol = preview.symbol;
    for (const p of preview.pins) previewNames[p.id] = p.name;
  }

  const svgWidth = cols * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;
  const svgHeight = rows * (CELL_SIZE + CELL_GAP) + GRID_PADDING * 2;
  const title = def ? `Edit ${def.name}` : "New custom part";

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onMouseUp={() => setDrag(null)}
    >
      <div
        className="font-sans bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-full max-w-5xl max-h-[96vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-mono text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {split ? (
          <div className="max-w-xl">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              Saved in this project only. {split.name} here no longer follows your library, and your library part stays as it was.
            </p>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-5">
              Keep this version as a new part in your library too?{projectSaves && " This also saves the project."}
            </p>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex gap-2 font-mono">
              <button onClick={keepSplitInLibrary} disabled={busy} className={primary}>Add to my library</button>
              <button onClick={onClose} disabled={busy} className={secondary}>No, done</button>
            </div>
          </div>
        ) : confirm ? (
          <div className="max-w-xl">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              {confirm.usage.length === 0
                ? "No other project uses this part yet. Only your library changes."
                : `This updates the part in your library and in ${
                    confirm.usage.length > 1
                      ? `these ${confirm.usage.length} projects`
                      : confirm.usage[0].edit_uuid === editUuid ? "this project" : "one project"
                  }:`}
            </p>
            {confirm.usage.length > 0 && (
              <ul className="text-sm text-neutral-700 dark:text-neutral-300 mb-3 max-h-60 overflow-auto border border-neutral-200 dark:border-neutral-700 rounded divide-y divide-neutral-200 dark:divide-neutral-700">
                {confirm.usage.map((u) => (
                  <li key={u.edit_uuid} className="px-3 py-1.5 flex gap-2">
                    <span className="truncate">{u.name}</span>
                    {u.edit_uuid === editUuid && <span className="text-neutral-400">(open now)</span>}
                    {u.placed > 0 && <span className="ml-auto shrink-0 text-neutral-500">{u.placed} placed</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-5">
              Copies you changed in a single project are not touched. If the part now sits differently on the board, placed copies go back to the unplaced list.{projectSaves && " This project is saved along with it."}
            </p>
            <div className="flex gap-2 font-mono">
              <button onClick={updateLibrary} disabled={busy} className={primary}>Update everywhere</button>
              <button onClick={() => setConfirm(null)} disabled={busy} className={secondary}>Back</button>
            </div>
          </div>
        ) : (
          <>
            {!def && (
              <div className="flex gap-1 mb-5 font-mono text-sm" role="tablist">
                {(["body", "grid"] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={`px-4 py-1.5 rounded ${mode === m ? "bg-[#113768] text-white" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
                  >
                    {m === "body" ? "From a body" : "Draw on a grid"}
                  </button>
                ))}
                <span className="ml-3 self-center font-sans text-xs text-neutral-500 dark:text-neutral-400">
                  {mode === "body"
                    ? "An IC, a three-leg part or an op amp: pick the body, name the pins."
                    : "Any shape: paint the body, put pins where the legs are."}
                </span>
              </div>
            )}

            {/* One height for both tabs, so switching does not move the buttons */}
            <div className="grid gap-6 md:grid-cols-[300px_1fr] md:h-[calc(94vh-230px)] md:min-h-[460px]">
              {/* What the part is */}
              <div className="space-y-3 md:overflow-auto md:pr-1">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className={label}>Name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
                  </div>
                  <div className="w-20">
                    <label className={label}>Label prefix</label>
                    <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={3} className={`${input} text-center`} />
                  </div>
                </div>
                <div>
                  <label className={label}>Description (optional)</label>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is, for search" className={input} />
                </div>
                <div>
                  <label className={label}>Also list under</label>
                  <select value={group} onChange={(e) => setGroup(e.target.value)} className={input}>
                    <option value="">Custom only</option>
                    {COMPONENT_GROUP_LABELS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>

                {mode === "body" && (
                  <div>
                    <label className={label}>Body</label>
                    <select value={bodyKind} onChange={(e) => chooseBody(e.target.value as BodyKind)} className={input}>
                      {BODIES.map((b) => <option key={b.kind} value={b.kind}>{b.label}</option>)}
                    </select>
                    {(bodyKind === "dip" || bodyKind === "sip") && (
                      <div className="mt-2">
                        <label className={label}>Pins</label>
                        <select value={names.length} onChange={(e) => resize(Number(e.target.value))} className={input}>
                          {(bodyKind === "dip" ? DIP_COUNTS : Array.from({ length: 39 }, (_, i) => i + 2)).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {/* Schematic preview */}
                <div>
                  <span className={label}>Schematic</span>
                  <svg
                    viewBox={previewBox}
                    className="w-full h-48 border border-neutral-200 dark:border-neutral-700 rounded bg-[var(--schematic-bg)]"
                  >
                    <g ref={previewRef}>
                      <SymbolRenderer symbolId={previewSymbol} pinNames={previewNames} showPinLabels />
                    </g>
                  </svg>
                </div>
              </div>

              {/* The pins */}
              <div className="min-w-0 md:overflow-auto">
                {mode === "body" ? (
                  <>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                      {bodyKind === "opamp"
                        ? "The 741 pinout: pin 2 is the inverting input, 3 the non-inverting input, 4 V−, 6 the output, 7 V+. Pins 1, 5 and 8 are not drawn."
                        : bodyKind === "to"
                          ? "Name each leg in datasheet order and pick the side of the box it comes out of."
                          : "Name the pins in datasheet order, pin 1 first."}
                    </div>
                    {bodyKind === "to" ? (
                      <div className="space-y-1.5">
                        {names.map((_, i) => (
                          <div key={i} className="flex items-center gap-2">
                            {pinField(i, "left")}
                            <select
                              value={sides[i]}
                              onChange={(e) => setSides(sides.map((s, j) => (j === i ? (e.target.value as Side) : s)))}
                              aria-label={`Pin ${i + 1} side`}
                              className={`${input} w-28`}
                            >
                              {(Object.keys(SIDE_LABELS) as Side[]).map((s) => <option key={s} value={s}>{SIDE_LABELS[s]}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    ) : bodyKind === "sip" ? (
                      // One row of legs: drawn standing, pin 1 at the top
                      <div className="flex items-stretch gap-3 w-fit">
                        <div className="w-5 border-2 border-neutral-400 dark:border-neutral-500 rounded-sm" aria-hidden />
                        <div className="flex flex-col gap-1.5">{names.map((_, i) => pinField(i, "left"))}</div>
                      </div>
                    ) : (
                      // Pins as they sit on the chip seen from above: 1 at the
                      // top left, down the left side, back up the right side
                      <div className="flex items-stretch gap-3 w-fit">
                        <div className="flex flex-col gap-1.5">
                          {names.slice(0, names.length / 2).map((_, i) => pinField(i, "left"))}
                        </div>
                        <div className="relative w-20 border-2 border-neutral-400 dark:border-neutral-500 rounded-sm" aria-hidden>
                          <div className="absolute left-1/2 -translate-x-1/2 -top-0.5 w-5 h-2.5 border-2 border-t-0 border-neutral-400 dark:border-neutral-500 rounded-b-full" />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {names.map((_, i) => names.length - 1 - i).slice(0, names.length / 2).map((i) => pinField(i, "right"))}
                        </div>
                      </div>
                    )}
                    {bodyKind === "to" && !sidesTaken && (
                      <div className="text-xs text-amber-600 mt-2">Each leg needs a side of its own.</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-4 mb-2 font-mono text-sm text-neutral-700 dark:text-neutral-300">
                      <div className="flex items-center gap-1">
                        <span>Rows: {rows}</span>
                        <button onClick={addRow} aria-label="Add a row" className="px-2.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">+</button>
                        <button onClick={removeRow} aria-label="Remove the last row" className="px-2.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">−</button>
                      </div>
                      <div className="flex items-center gap-1">
                        <span>Cols: {cols}</span>
                        <button onClick={addCol} aria-label="Add a column" className="px-2.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">+</button>
                        <button onClick={removeCol} aria-label="Remove the last column" className="px-2.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700">−</button>
                      </div>
                      <button
                        onClick={() => select(gridPins.map((p) => `${p.offsetRow},${p.offsetCol}`))}
                        disabled={gridPins.length === 0}
                        className="px-2.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
                      >
                        Select all pins
                      </button>
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                      One cell is one hole. Click an empty cell to add a pin there. Click a pin to select it, shift-click to select more, drag to move the selection, Del to remove it.
                    </div>
                    <div className="overflow-auto">
                      {(() => {
                        const targets = drag ? moveTargets(drag.from, drag.to) : null;
                        const moved = drag !== null && (drag.from.row !== drag.to.row || drag.from.col !== drag.to.col);
                        const landing = new Set(targets && moved ? targets.values() : []);
                        const cellX = (c: number) => GRID_PADDING + c * (CELL_SIZE + CELL_GAP);
                        const cellY = (r: number) => GRID_PADDING + r * (CELL_SIZE + CELL_GAP);
                        return (
                          <svg
                            width={svgWidth}
                            height={svgHeight}
                            className="font-sans border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 select-none"
                            onMouseUp={finishDrag}
                            onMouseLeave={() => setDrag(null)}
                          >
                            {grid.map((row, r) =>
                              row.map((cell, c) => {
                                const key = `${r},${c}`;
                                const x = cellX(c);
                                const y = cellY(r);
                                const isPin = typeof cell === "object";
                                const isSelected = selected.has(key);
                                const leaving = moved && isSelected && targets !== null;
                                const isEditingThis = editingPin?.row === r && editingPin?.col === c;
                                return (
                                  <g
                                    key={key}
                                    style={{ cursor: isPin ? "grab" : "pointer" }}
                                    onClick={() => handleCellClick(r, c)}
                                    onMouseDown={(e) => handleCellMouseDown(e, r, c)}
                                    onMouseEnter={() => drag && setDrag({ ...drag, to: { row: r, col: c } })}
                                  >
                                    <rect
                                      x={x} y={y} width={CELL_SIZE} height={CELL_SIZE} rx={4}
                                      fill={leaving ? "#e5e5e5" : landing.has(key) ? "#efdcae" : isPin ? "#404040" : "#d4d4d4"}
                                      stroke={isSelected || isEditingThis ? "#D4A853" : "#a3a3a3"}
                                      strokeWidth={isSelected || isEditingThis ? 3 : 1}
                                    />
                                    {isPin && !leaving && (
                                      <>
                                        <circle cx={x + CELL_SIZE / 2} cy={y + CELL_SIZE / 2 - 4} r={5} fill="white" pointerEvents="none" />
                                        <text x={x + CELL_SIZE / 2} y={y + CELL_SIZE / 2 + 10} textAnchor="middle" fontSize={7} fill="white" pointerEvents="none">
                                          {cell.pinName}
                                        </text>
                                      </>
                                    )}
                                    {!isPin && <circle cx={x + CELL_SIZE / 2} cy={y + CELL_SIZE / 2} r={2.5} fill="#a3a3a3" pointerEvents="none" />}
                                  </g>
                                );
                              })
                            )}
                            {/* Where the selection lands, or a red cell when it cannot go there */}
                            {moved && targets && [...targets].map(([from, to]) => {
                              const f = cellOf(from);
                              const t = cellOf(to);
                              const cell = grid[f.row][f.col];
                              return (
                                <g key={`ghost-${from}`} pointerEvents="none" opacity={0.75}>
                                  <rect x={cellX(t.col)} y={cellY(t.row)} width={CELL_SIZE} height={CELL_SIZE} rx={4} fill="#404040" stroke="#D4A853" strokeWidth={2} />
                                  <circle cx={cellX(t.col) + CELL_SIZE / 2} cy={cellY(t.row) + CELL_SIZE / 2 - 4} r={5} fill="white" />
                                  <text x={cellX(t.col) + CELL_SIZE / 2} y={cellY(t.row) + CELL_SIZE / 2 + 10} textAnchor="middle" fontSize={7} fill="white">
                                    {typeof cell === "object" ? cell.pinName : ""}
                                  </text>
                                </g>
                              );
                            })}
                            {moved && !targets && drag && (
                              <rect
                                x={cellX(drag.to.col)} y={cellY(drag.to.row)} width={CELL_SIZE} height={CELL_SIZE} rx={4}
                                fill="none" stroke="#dc2626" strokeWidth={2} pointerEvents="none"
                              />
                            )}
                          </svg>
                        );
                      })()}
                    </div>

                    {(editingPin || selected.size === 1) && (
                      // Keyed so a new pin's form mounts afresh and its number field takes the focus
                      <div key={editingPin ? `new-${editingPin.row},${editingPin.col}` : "selected"} className="flex flex-wrap gap-2 mt-3 items-end">
                        <div>
                          <label className={label}>Pin number</label>
                          <input
                            autoFocus={editingPin !== null}
                            value={pinId}
                            onChange={(e) => setPinId(e.target.value)}
                            className={`${input} w-20`}
                            onKeyDown={(e) => e.key === "Enter" && commitPin()}
                          />
                        </div>
                        <div>
                          <label className={label}>Pin name</label>
                          <input
                            value={pinName}
                            onChange={(e) => setPinName(e.target.value)}
                            className={`${input} w-32`}
                            onKeyDown={(e) => e.key === "Enter" && commitPin()}
                          />
                        </div>
                        <button onClick={commitPin} className={primary}>{editingPin ? "Add pin" : "Set"}</button>
                        {editingPin && <button onClick={() => setEditingPin(null)} className={secondary}>Cancel</button>}
                      </div>
                    )}
                    {!editingPin && selected.size > 0 && (
                      <div className="flex flex-wrap items-center gap-2 mt-3 text-sm text-neutral-700 dark:text-neutral-300">
                        {selected.size > 1 && <span>{selected.size} pins selected. Drag any of them to move them all.</span>}
                        {confirmRemove ? (
                          <>
                            <span>Remove {selected.size === 1 ? "this pin" : `these ${selected.size} pins`}?</span>
                            <button onClick={removeSelected} className="bg-red-500 dark:bg-red-600 text-white text-sm px-3 py-1.5 rounded hover:bg-red-600">Remove</button>
                            <button onClick={() => setConfirmRemove(false)} className={secondary}>Keep</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmRemove(true)} className={secondary}>
                            {selected.size === 1 ? "Remove pin" : `Remove ${selected.size} pins`}
                          </button>
                        )}
                      </div>
                    )}
                    {gridPins.length === 0 && (
                      <div className="text-xs text-amber-600 mt-2">Add at least one pin to make a part.</div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Where it goes */}
            <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700 flex flex-wrap items-center gap-3">
              {!def && !libraryOnly && (
                <div className="flex items-center gap-4 text-sm text-neutral-700 dark:text-neutral-300">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={saveTo === "project"} onChange={() => setSaveTo("project")} />
                    This project
                  </label>
                  <label className={`flex items-center gap-1.5 ${signedIn ? "" : "opacity-50"}`} title={signedIn ? undefined : "Log in to keep parts for all your projects"}>
                    <input type="radio" checked={saveTo === "library"} onChange={() => setSaveTo("library")} disabled={!signedIn} />
                    My library (all my projects)
                  </label>
                </div>
              )}
              {def && editing?.where === "project" && signedIn && !linked && (
                <label className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                  <input type="checkbox" checked={alsoToLibrary} onChange={(e) => setAlsoToLibrary(e.target.checked)} />
                  Also save it to my library
                </label>
              )}
              {error && <span className="text-sm text-red-600">{error}</span>}
              {!changed && !alsoToLibrary && <span className="text-sm text-neutral-500 dark:text-neutral-400">No changes yet</span>}
              {projectSaves && (linked || alsoToLibrary || (!def && saveTo === "library")) && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">Changes to your library also save this project.</span>
              )}

              <div className="ml-auto flex flex-wrap justify-end gap-2 font-mono">
                {!def && (
                  <button onClick={saveTo === "library" ? saveNewToLibrary : saveInProject} disabled={!valid || busy} className={primary}>
                    Create part
                  </button>
                )}
                {def && linked && (
                  <button onClick={reviewLibraryUpdate} disabled={!valid || !changed || busy} className={primary} title="Change the part in your library and in every project that uses it">
                    Update Component in library and all projects…
                  </button>
                )}
                {def && (linked || editing?.where === "project") && (
                  <button
                    onClick={saveInProject}
                    disabled={!valid || !(changed || alsoToLibrary) || busy}
                    className={linked ? secondary : primary}
                    title={linked ? "Change it here only; it stops following the library" : undefined}
                  >
                    {linked ? "Update Component in this project only" : "Save"}
                  </button>
                )}
                {def && !linked && editing?.where === "library" && (
                  <button onClick={reviewLibraryUpdate} disabled={!valid || !changed || busy} className={primary}>
                    Save…
                  </button>
                )}
                <button onClick={onClose} className={secondary}>Cancel</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
