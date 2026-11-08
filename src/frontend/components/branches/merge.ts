// Three-way merge of two branches of a project. `base` is their last common
// state, `target` the branch merged into, `source` the branch merged in.
//
// Everything is merged item by item (parts, part types, nets, wires, flags,
// cuts, board wires), matched by id or by position, and within an item field
// by field: a change made on one side is taken, the same change on both is
// fine, different changes to one field are a conflict the user decides.
//
// A part's board fields (where it sits, how it is turned, its leads) are kept
// apart from its schematic fields. When both branches changed the board, the
// user picks one board, or combines both and checks the result in the editor.
//
// Nets are carried along only for their names: the merged schematic is
// settled afterwards (settleProject), which infers them from the wiring.
import type { Board, Component, Cut, Project, Wire } from "@/types";

export type Side = "target" | "source";
export type BoardChoice = "combine" | "target" | "source";

export interface MergeChoices {
  // Conflict id -> the side whose version is kept
  items?: Record<string, Side>;
  // Only asked when both branches changed the board
  board?: BoardChoice;
}

export interface MergeConflict {
  id: string;
  area: "schematic" | "board" | "settings";
  label: string;
  detail: string;
  // The side that deleted the item, when the conflict is a delete against a change
  deletedOn?: Side;
}

export interface MergeOutcome {
  data: Project;
  conflicts: MergeConflict[];
  // Both branches changed the board: the user picks how to bring them together
  boardChangedOnBoth: boolean;
  // What the source brings in, in plain words
  changes: string[];
  // The merge leaves the target different from how it is now
  changesTarget: boolean;
}

export interface MergeNames {
  target: string;
  source: string;
}

// A part's fields that belong to the board rather than the schematic
const BOARD_FIELDS = [
  "boardPos", "rotation", "boardLabelOffset", "flexibleEndPos", "footprintOverride", "package",
  "boardExcluded", "offBoard", "leads", "leadLabelOffsets", "offBoardPackage", "locked",
] as const;
// What puts a part somewhere on the board; cleared when a part comes in
// without the board it was placed on
const PLACEMENT = ["boardPos", "flexibleEndPos", "leads", "boardLabelOffset", "leadLabelOffsets"] as const;

const COLLECTIONS = new Set(["componentDefs", "components", "nets", "netAssignments", "schematicWires", "netLabels", "board"]);
// Records about the project and its last auto-layout, not design decisions:
// they follow the board that is kept, never conflict
const BOOKKEEPING = new Set([
  "version", "name", "autoSave", "autoLayoutUsed", "boardEditsSinceAutoLayout", "autoLayoutRuns", "autoLayoutLastAt",
  "autoLayoutLastQuality", "autoLayoutVersion", "autoLayoutLastBoards", "autoLayoutLastOrderings",
  "autoLayoutLastDrilled", "boardAddsSinceAutoLayout", "v5RunS",
]);
const SETTING_NAMES: Record<string, string> = {
  description: "Description",
  notes: "Notes",
  wiring: "Wiring rules",
  showValuesOnBoard: "Values on the board",
  labelMovement: "Label movement",
  partSpacing: "Part spacing",
  drilledCutsOnly: "Drilled cuts only",
  allowStanding: "Standing parts",
  noWireStacking: "Wire stacking",
  v5Effort: "Auto-layout effort",
  v5RandomSeeds: "Random seeds",
  permWorkers: "Processor threads",
};

type Obj = Record<string, unknown>;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  // A key holding undefined is the same as no key
  const keys = new Set([...Object.keys(a as Obj), ...Object.keys(b as Obj)]);
  for (const k of keys) if (!deepEqual((a as Obj)[k], (b as Obj)[k])) return false;
  return true;
}

function pick(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function omit(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

class Ctx {
  conflicts: MergeConflict[] = [];
  constructor(public choices: MergeChoices, public names: MergeNames) {}
  side(id: string): Side {
    return this.choices.items?.[id] ?? "target";
  }
}

/** Field by field: one-sided changes are taken; fields changed differently on
 *  both sides are reported and resolved by `side`. */
function mergeFields(b: Obj, o: Obj, t: Obj, keys: Iterable<string>, side: Side): { value: Obj; conflicting: string[] } {
  const value: Obj = {};
  const conflicting: string[] = [];
  for (const k of keys) {
    let v: unknown;
    if (deepEqual(o[k], t[k]) || deepEqual(b[k], t[k])) v = o[k];
    else if (deepEqual(b[k], o[k])) v = t[k];
    else {
      conflicting.push(k);
      v = side === "target" ? o[k] : t[k];
    }
    if (v !== undefined) value[k] = v;
  }
  return { value, conflicting };
}

const allKeys = (...objs: (Obj | undefined)[]) => new Set(objs.flatMap((o) => (o ? Object.keys(o) : [])));

/**
 * A list of items matched by `key`. Kept in the target's order, with items
 * only the source has appended. `silent` lists resolve every conflict to the
 * target without asking (data the editor derives again anyway).
 */
function mergeList<T>(
  kind: string,
  area: MergeConflict["area"],
  base: T[], target: T[], source: T[],
  key: (x: T) => string,
  label: (x: T) => string,
  ctx: Ctx,
  silent = false,
): T[] {
  const B = new Map(base.map((x) => [key(x), x]));
  const O = new Map(target.map((x) => [key(x), x]));
  const S = new Map(source.map((x) => [key(x), x]));
  const order = [...O.keys(), ...[...S.keys()].filter((k) => !O.has(k))];
  const out: T[] = [];
  for (const k of order) {
    const b = B.get(k), o = O.get(k), t = S.get(k);
    const id = `${kind}:${k}`;
    let v: T | undefined;
    if (deepEqual(o, t) || deepEqual(b, t)) v = o;
    else if (deepEqual(b, o)) v = t;
    else if (o !== undefined && t !== undefined) {
      const side = silent ? "target" : ctx.side(id);
      const { value, conflicting } = mergeFields((b ?? {}) as Obj, o as Obj, t as Obj, allKeys(b as Obj, o as Obj, t as Obj), side);
      if (conflicting.length > 0 && !silent) {
        ctx.conflicts.push({ id, area, label: label(o), detail: b ? "changed differently on both branches" : "added differently on both branches" });
      }
      v = value as T;
    } else {
      // Deleted on one side, changed on the other
      const deletedOn: Side = o === undefined ? "target" : "source";
      if (!silent) {
        const { target: tn, source: sn } = ctx.names;
        ctx.conflicts.push({
          id, area, label: label((o ?? t)!), deletedOn,
          detail: deletedOn === "target" ? `deleted on ${tn}, changed on ${sn}` : `changed on ${tn}, deleted on ${sn}`,
        });
      }
      v = (silent ? "target" : ctx.side(id)) === "target" ? o : t;
    }
    if (v !== undefined) out.push(v);
  }
  return out;
}

// A cut between two holes and a drilled hole can share a position
const cutKey = (c: Cut) => `${c.row},${c.col},${c.kind ?? ""}`;
// A board wire is where it runs: auto-layout gives every wire a new id
const wireKey = (w: Wire) => {
  const a = `${w.from.row},${w.from.col}`, b = `${w.to.row},${w.to.col}`;
  return a < b ? `${a}-${b}` : `${b}-${a}`;
};
const placed = (c: Component) => c.boardPos != null || (!!c.offBoard && !!c.leads && Object.keys(c.leads).length > 0);

/** What a branch's board looks like: size, copper work and where parts sit. */
function boardView(p: Project) {
  const b = p.board;
  return {
    size: pick(b as unknown as Obj, ["rows", "cols", "lockedRows", "lockedCols"]),
    cuts: [...new Set(b.cuts.map(cutKey))].sort(),
    wires: b.wires.map(wireKey).sort(),
    parts: Object.fromEntries(p.components.filter(placed).map((c) => [c.id, pick(c as unknown as Obj, BOARD_FIELDS)])),
  };
}

function clearPlacement(c: Component): Component {
  const out = omit(c as unknown as Obj, PLACEMENT) as unknown as Component;
  out.boardPos = null;
  return out;
}

function mergeComponents(base: Project, target: Project, source: Project, boardMode: BoardChoice, ctx: Ctx): Component[] {
  const B = new Map(base.components.map((c) => [c.id, c]));
  const O = new Map(target.components.map((c) => [c.id, c]));
  const S = new Map(source.components.map((c) => [c.id, c]));
  const order = [...O.keys(), ...[...S.keys()].filter((k) => !O.has(k))];
  const { target: tn, source: sn } = ctx.names;
  // Board fields only count from a side whose board is kept
  const boardCounts = (side: Side) => boardMode === "combine" || boardMode === side;
  const view = (c: Component | undefined, side: Side | "base") =>
    c === undefined ? undefined
      : side === "base" || boardCounts(side) ? (c as unknown as Obj)
        : omit(c as unknown as Obj, BOARD_FIELDS);
  const out: Component[] = [];

  for (const id of order) {
    const b = B.get(id), o = O.get(id), t = S.get(id);
    const bo = view(b, "base"), oo = view(o, "target"), to = view(t, "source");
    // In a kept board's view, the base is compared on the same fields
    const bSide = (side: Side) => (b && !boardCounts(side) ? omit(b as unknown as Obj, BOARD_FIELDS) : bo);
    const label = (o ?? t ?? b)!.label;
    let result: Component | undefined;

    if (o && t) {
      // Schematic fields: always merged; board fields: by the board choice
      const schematicKeys = [...allKeys(b as Obj | undefined, o as unknown as Obj, t as unknown as Obj)]
        .filter((k) => !(BOARD_FIELDS as readonly string[]).includes(k));
      const sid = `component:${id}`;
      const sch = mergeFields((b ?? {}) as Obj, o as unknown as Obj, t as unknown as Obj, schematicKeys, ctx.side(sid));
      if (sch.conflicting.length > 0) {
        ctx.conflicts.push({ id: sid, area: "schematic", label, detail: `${sch.conflicting.join(", ")} changed differently on both branches` });
      }
      let board: Obj;
      if (boardMode === "combine") {
        const bid = `component-board:${id}`;
        const brd = mergeFields(
          pick((b ?? {}) as Obj, BOARD_FIELDS), pick(o as unknown as Obj, BOARD_FIELDS), pick(t as unknown as Obj, BOARD_FIELDS),
          BOARD_FIELDS, ctx.side(bid),
        );
        if (brd.conflicting.length > 0) {
          const moved = brd.conflicting.some((k) => k === "boardPos" || k === "leads");
          ctx.conflicts.push({ id: bid, area: "board", label, detail: moved ? "placed differently on both branches" : "changed differently on the board on both branches" });
        }
        board = brd.value;
      } else {
        board = pick((boardMode === "target" ? o : t) as unknown as Obj, BOARD_FIELDS);
      }
      result = { ...sch.value, ...board } as unknown as Component;
      if (result.boardPos === undefined) result.boardPos = null;
    } else if (!o && !t) {
      result = undefined; // deleted on both
    } else {
      const present = (o ?? t)!;
      const presentSide: Side = o ? "target" : "source";
      const absentSide: Side = o ? "source" : "target";
      const presentView = presentSide === "target" ? oo : to;
      if (!b) {
        // Added on one side only
        result = presentSide === "source" && !boardCounts("source") ? clearPlacement(present)
          : presentSide === "target" && !boardCounts("target") ? clearPlacement(present)
            : present;
      } else if (deepEqual(bSide(presentSide), presentView)) {
        result = undefined; // deleted on one side, untouched on the other
      } else {
        const cid = `component:${id}`;
        ctx.conflicts.push({
          id: cid, area: "schematic", label, deletedOn: absentSide,
          detail: absentSide === "target" ? `deleted on ${tn}, changed on ${sn}` : `changed on ${tn}, deleted on ${sn}`,
        });
        result = ctx.side(cid) === presentSide ? present : undefined;
        if (result && !boardCounts(presentSide)) result = clearPlacement(result);
      }
    }
    if (result) out.push(result);
  }
  return out;
}

function mergeBoard(base: Board, target: Board, source: Board, mode: BoardChoice, ctx: Ctx): Board {
  if (mode !== "combine") return structuredClone(mode === "target" ? target : source);
  const size = ["rows", "cols", "lockedRows", "lockedCols", "pattern"];
  const sid = "board-size";
  const group = (b: Board) => pick(b as unknown as Obj, size);
  let sizes = mergeFields(group(base), group(target), group(source), size, ctx.side(sid));
  if (!deepEqual(base.pattern, target.pattern) || !deepEqual(base.pattern, source.pattern)) {
    // Another board comes with its own size: the two are one choice
    const whole = mergeFields({ board: group(base) }, { board: group(target) }, { board: group(source) }, ["board"], ctx.side(sid));
    sizes = { value: whole.value.board as Obj, conflicting: whole.conflicting.length > 0 ? ["pattern"] : [] };
  }
  if (sizes.conflicting.includes("pattern")) {
    ctx.conflicts.push({ id: sid, area: "board", label: "Board", detail: "a different board on both branches" });
  } else if (sizes.conflicting.length > 0) {
    ctx.conflicts.push({ id: sid, area: "board", label: "Board size", detail: "changed differently on both branches" });
  }
  const cuts = mergeList("cut", "board", base.cuts, target.cuts, source.cuts, cutKey,
    (c) => `Cut at row ${c.row + 1}, column ${c.col + 1}`, ctx);
  const wires = mergeList("board-wire", "board", base.wires, target.wires, source.wires, wireKey,
    (w) => `Wire ${w.from.row + 1}:${w.from.col + 1} to ${w.to.row + 1}:${w.to.col + 1}`, ctx);
  // what the merge left out (plain stripboard, an unlocked size) stays out
  return { ...(omit(target as unknown as Obj, size) as unknown as Board), ...(sizes.value as Partial<Board>), cuts, wires };
}

function mergeSettings(base: Project, target: Project, source: Project, boardMode: BoardChoice, ctx: Ctx): Obj {
  const b = base as unknown as Obj, o = target as unknown as Obj, t = source as unknown as Obj;
  const out: Obj = {};
  for (const k of allKeys(b, o, t)) {
    if (COLLECTIONS.has(k)) continue;
    if (BOOKKEEPING.has(k)) {
      const from = k.startsWith("autoLayout") || k.startsWith("board") || k === "v5RunS" ? (boardMode === "source" ? t : o) : o;
      if (from[k] !== undefined) out[k] = from[k];
      continue;
    }
    const id = `setting:${k}`;
    const { value, conflicting } = mergeFields(b, o, t, [k], ctx.side(id));
    if (conflicting.length > 0) {
      ctx.conflicts.push({ id, area: "settings", label: SETTING_NAMES[k] ?? k, detail: "changed differently on both branches" });
    }
    if (value[k] !== undefined) out[k] = value[k];
  }
  return out;
}

/** What the source changed since the base, in plain words. */
export function describeChanges(base: Project, source: Project, withBoard: boolean): string[] {
  const lines: string[] = [];
  const names = (list: string[], max = 6) =>
    list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
  const B = new Map(base.components.map((c) => [c.id, c]));
  const S = new Map(source.components.map((c) => [c.id, c]));
  const added = source.components.filter((c) => !B.has(c.id)).map((c) => c.label);
  const removed = base.components.filter((c) => !S.has(c.id)).map((c) => c.label);
  const changed: string[] = [];
  const moved: string[] = [];
  for (const c of source.components) {
    const b = B.get(c.id);
    if (!b) continue;
    if (!deepEqual(omit(b as unknown as Obj, BOARD_FIELDS), omit(c as unknown as Obj, BOARD_FIELDS))) changed.push(c.label);
    if (!deepEqual(pick(b as unknown as Obj, BOARD_FIELDS), pick(c as unknown as Obj, BOARD_FIELDS))) moved.push(c.label);
  }
  if (added.length) lines.push(`Parts added: ${names(added)}`);
  if (removed.length) lines.push(`Parts removed: ${names(removed)}`);
  if (changed.length) lines.push(`Parts changed in the schematic: ${names(changed)}`);

  const count = <T>(a: T[], b: T[], key: (x: T) => string) => {
    const A = new Set(a.map(key)), Bs = new Set(b.map(key));
    return { added: [...Bs].filter((k) => !A.has(k)).length, removed: [...A].filter((k) => !Bs.has(k)).length };
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const tally = (what: string, c: { added: number; removed: number }) => {
    const parts = [c.added && `${c.added} added`, c.removed && `${c.removed} removed`].filter(Boolean);
    if (parts.length) lines.push(`${what}: ${parts.join(", ")}`);
  };
  tally("Schematic wires", count(base.schematicWires, source.schematicWires, (w) => JSON.stringify([w.start, w.end])));
  tally("Net flags", count(base.netLabels ?? [], source.netLabels ?? [], (l) => JSON.stringify([l.kind, l.name, l.pos])));

  const baseNets = new Map(base.nets.map((n) => [n.id, n.name]));
  const renamed = source.nets.filter((n) => baseNets.has(n.id) && baseNets.get(n.id) !== n.name)
    .map((n) => `${baseNets.get(n.id)} to ${n.name}`);
  if (renamed.length) lines.push(`Nets renamed: ${names(renamed, 4)}`);
  tally("Nets", count(base.nets, source.nets, (n) => n.id));

  if (withBoard) {
    if (moved.length) lines.push(`Parts moved on the board: ${names(moved)}`);
    tally("Cuts", count(base.board.cuts, source.board.cuts, cutKey));
    tally("Board wires", count(base.board.wires, source.board.wires, wireKey));
    const boardName = (b: Board) => b.pattern?.name ?? "Stripboard";
    if (!deepEqual(base.board.pattern, source.board.pattern)) {
      lines.push(boardName(base.board) === boardName(source.board)
        ? `Board: ${boardName(source.board)} changed`
        : `Board: ${boardName(base.board)} to ${boardName(source.board)}`);
    } else if (base.board.rows !== source.board.rows || base.board.cols !== source.board.cols) {
      lines.push(`Board size: ${base.board.cols} x ${base.board.rows} to ${source.board.cols} x ${source.board.rows}`);
    }
    const locks = (b: Board) => `${b.lockedRows ? "rows" : ""}${b.lockedCols ? "cols" : ""}`;
    if (locks(base.board) !== locks(source.board)) lines.push("Board size locks changed");
  }
  const settings = [...allKeys(base as unknown as Obj, source as unknown as Obj)]
    .filter((k) => !COLLECTIONS.has(k) && !BOOKKEEPING.has(k))
    .filter((k) => !deepEqual((base as unknown as Obj)[k], (source as unknown as Obj)[k]))
    .map((k) => SETTING_NAMES[k] ?? k);
  if (settings.length) lines.push(`Settings: ${settings.join(", ")}`);
  const defs = count(base.componentDefs, source.componentDefs, (d) => JSON.stringify(d));
  if (defs.added || defs.removed) lines.push(`Part types: ${plural(Math.max(defs.added, defs.removed), "change")}`);
  return lines;
}

export function mergeProjects(base: Project, target: Project, source: Project, choices: MergeChoices, names: MergeNames): MergeOutcome {
  const ctx = new Ctx(choices, names);
  const baseBoard = boardView(base);
  const targetChanged = !deepEqual(baseBoard, boardView(target));
  const sourceChanged = !deepEqual(baseBoard, boardView(source));
  const boardChangedOnBoth = targetChanged && sourceChanged;
  const boardMode: BoardChoice = boardChangedOnBoth ? choices.board ?? "combine" : "combine";

  const componentDefs = mergeList("part-type", "schematic", base.componentDefs, target.componentDefs, source.componentDefs,
    (d) => d.id, (d) => `Part type ${d.name}`, ctx);
  const components = mergeComponents(base, target, source, boardMode, ctx);
  // A part needs its type: a custom one deleted on one side but used on the
  // other comes back. (Built-in types are not stored with a project.)
  const defIds = new Set(componentDefs.map((d) => d.id));
  for (const c of components) {
    if (defIds.has(c.defId)) continue;
    const def = target.componentDefs.find((d) => d.id === c.defId) ?? source.componentDefs.find((d) => d.id === c.defId);
    if (def) {
      componentDefs.push(def);
      defIds.add(def.id);
    }
  }
  const compIds = new Set(components.map((c) => c.id));

  const nets = mergeList("net", "schematic", base.nets, target.nets, source.nets, (n) => n.id, (n) => `Net ${n.name}`, ctx);
  const netAssignments = mergeList("pin", "schematic", base.netAssignments, target.netAssignments, source.netAssignments,
    (a) => `${a.componentId}:${a.pinId}`, (a) => a.pinId, ctx, true).filter((a) => compIds.has(a.componentId));
  const schematicWires = mergeList("wire", "schematic", base.schematicWires, target.schematicWires, source.schematicWires,
    (w) => w.id, () => "Schematic wire", ctx);
  const netLabels = mergeList("flag", "schematic", base.netLabels ?? [], target.netLabels ?? [], source.netLabels ?? [],
    (l) => l.id, (l) => `Flag ${l.name}`, ctx);
  const board = mergeBoard(base.board, target.board, source.board, boardMode, ctx);
  const settings = mergeSettings(base, target, source, boardMode, ctx);

  const data = {
    ...settings, componentDefs, components, nets, netAssignments, schematicWires, netLabels, board,
  } as unknown as Project;
  data.name = target.name;
  const changes = describeChanges(base, source, !boardChangedOnBoth || boardMode !== "target");
  const changesTarget = !deepEqual(comparable(data), comparable(target));
  // Anything the summary has no line for still gets one, so it never reads as nothing
  if (changesTarget && changes.length === 0) changes.push("Small changes (settings or details)");
  return { data, conflicts: ctx.conflicts, boardChangedOnBoth, changes, changesTarget };
}

/** A design as a merge compares it: pin assignments are inferred from the
 *  wiring again afterwards, and a cut saved twice is one cut. */
function comparable(p: Project): Obj {
  const out = omit(p as unknown as Obj, ["name", "netAssignments"]);
  const board = p.board;
  out.board = { ...board, cuts: [...new Set(board.cuts.map(cutKey))].sort(), wires: board.wires.map(wireKey).sort() };
  return out;
}
