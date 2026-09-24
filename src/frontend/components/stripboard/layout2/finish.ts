import { Board, BoardPosition, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getFlexiblePinPositions, getRotatedPinPositions } from "../boardLayout";
import { flexBodiesClash, flexClashesRect, flexProfile, flexWireObstacle, rigidBody, rigidGeometry } from "../partGeometry";
import { collectBoardPins, collectOccupiedHoles } from "../boardPins";
import { holeKey } from "../keys";
import { AutoLayoutResult } from "../layoutTypes";
import { Rot } from "./tileModel";
import { WireObstacles, bodyRectsClash, corridorHoles, segmentIntersectsRect, segmentsIntersect, spanLimits, wireCrossesBody, wireStackDepth } from "../flexGeometry";
import { alignCuts } from "./alignCuts";
import { insertLine, padAroundEdgeConnectors } from "./edgePadding";
import { drillRemainingCuts } from "../autoFinish";
import { Chooser } from "./chooser";
import { compactPlacements } from "./compaction";
import { insertWireChannels } from "./channelPass";
import { repairSlantWires } from "./slantRepairPass";
import { trimResult } from "./trimResult";
import { wireMessScore } from "./tidyScore";
import { BoardPricer, priceResult } from "./boardPrice";
import { pinKey } from "../keys";
import { computeStripSegments } from "../stripSegments";
import { computeConnectivity } from "../connectivity";
import { checkNetCompleteness } from "../netCompleteness";
import type { LabBoard, LabFrame } from "../autoLayout5";

// ── The finish: from the anneal's skeleton to the board you get ──
// The anneal hands over a skeleton: where every part sits, how big the
// decoded board is, and what its own decoder made of it. Everything here is
// a function of that record alone, so a skeleton can be stored and the
// finish replayed on it without the anneal. The editor's real router starts
// over from the placed parts: routing room at the rim, cuts and wires, the
// harvest of empty lines, wire channels until nothing slants or crosses, a
// slant repair, the free-line pass, the trim, then cut alignment and the
// drill upgrade.

export interface Skeleton {
  // decoded extent, no margins
  rows: number;
  cols: number;
  // the parts the anneal placed; a locked rigid keeps its own place
  placed: { id: string; boardPos: BoardPosition; rotation: Rot; flexibleEndPos?: BoardPosition; locked?: boolean }[];
  // parts the model could not plan, in the order they were skipped
  skippedIds: string[];
  // what the decoder measured on this skeleton
  metrics: { eBase: number; mess: number; wires: number; wireLen: number; cuts: number; bCuts: number };
  // the decoder's own board (strips, cuts, wires), margin included: the
  // starting point for a finish that repairs instead of re-routing
  wiring?: LabBoard;
}

export interface FinishOptions {
  drilledCutsOnly?: boolean;
  noWireStacking?: boolean;
  // Harness switches for the finish-only replay. Unset: as the editor, both
  // finishes and the cheaper board. "fallback": the repaired board when it is
  // valid and clean, else the router's. "only": the repaired board whatever it
  // is. "never": the router's board.
  repair?: "fallback" | "only" | "never";
}

// Explainer hook: frames land in `frames`, `board` draws a routed board
export interface FinishLab {
  frames: LabFrame[];
  board: (virtual: Component[], rows: number, cols: number, cuts: AutoLayoutResult["cuts"], wires: { from: BoardPosition; to: BoardPosition }[]) => LabBoard;
}

export function finishSkeleton(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  skeleton: Skeleton,
  options?: FinishOptions,
  lab?: FinishLab
): { final: AutoLayoutResult; score: number } {
  const lockedColsCap = board.lockedCols ? board.cols : undefined;
  const lockedRowsCap = board.lockedRows ? board.rows : undefined;
  const hasLocked = skeleton.placed.some((p) => p.locked);
  const skippedSet = new Set(skeleton.skippedIds);
  const skipped = components.filter((c) => skippedSet.has(c.id));
  // the routing room around the skeleton is added below
  // (padAroundEdgeConnectors), none under locked parts or a locked dimension
  const padRows = hasLocked || lockedRowsCap !== undefined ? 0 : 1;
  const padCols = hasLocked || lockedColsCap !== undefined ? 0 : 1;
  const comps0: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0 as Rot }));
  const byId = new Map(comps0.map((c) => [c.id, c]));
  for (const p of skeleton.placed) {
    const c = byId.get(p.id)!;
    c.boardPos = p.boardPos;
    c.rotation = p.rotation;
    if (p.flexibleEndPos) c.flexibleEndPos = p.flexibleEndPos;
    if (p.locked) c.locked = true;
  }
  const padLines = { top: padRows, bottom: padRows, left: padCols, right: 2 * padCols };
  const padded = padAroundEdgeConnectors(comps0, componentDefs, skeleton.rows, skeleton.cols, padLines);
  const comps = padded.comps;
  const H = lockedRowsCap !== undefined ? Math.max(padded.rows, lockedRowsCap) : padded.rows;
  const W = lockedColsCap !== undefined ? Math.max(padded.cols, lockedColsCap) : padded.cols;
  const routeBoard: Board = { ...board, rows: H, cols: W, cuts: [], wires: [] };
  const movedIds = new Set(skeleton.placed.map((p) => p.id));
  const pricer = new BoardPricer(componentDefs, components, {
    ...(lockedRowsCap !== undefined ? { maxRows: lockedRowsCap } : {}),
    ...(lockedColsCap !== undefined ? { maxCols: lockedColsCap } : {}),
  }, options?.drilledCutsOnly ?? false);
  const chooser = new Chooser(routeBoard, componentDefs, nets, netAssignments, false, {}, options?.drilledCutsOnly ?? false, true, options?.noWireStacking ?? false, pricer);
  chooser.route(comps, H, W, movedIds);
  // rim connectors kept on the rim first; a board that does not route that
  // way (a pin left without a free hole) gets the plain shift instead
  if (chooser.chosen!.bad > 0) {
    chooser.route(padAroundEdgeConnectors(comps0, componentDefs, skeleton.rows, skeleton.cols, padLines, false).comps, H, W, movedIds);
  }
  chooser.freezePool();
  const pushFin = (msg: string) => {
    const c = chooser.chosen;
    if (!c || !lab) return;
    lab.frames.push({ stage: 7, msg, board: lab.board(c.virtual, c.rows, c.cols, c.plan.cuts, c.plan.wires) });
  };
  if (lab) {
    const c = chooser.chosen!;
    const full = lab.board(c.virtual, c.rows, c.cols, c.plan.cuts, c.plan.wires);
    const nWires = full.wires.length;
    const knives = c.plan.cuts.filter((k) => k.kind !== "hole").length;
    lab.frames.push({ stage: 7, msg: `A slower, far more thorough router starts over from the same components. First it buys routing room: a blank line on each side and two on the right; a connector on the left or right rim keeps its place there and everything else moves sideways. Then the cuts: ${full.cuts.length}${knives === 0 ? ", every one of them a drilled-out spare hole" : `, ${knives} of them cut with a knife between two holes`}.`, board: { ...full, wires: [] } });
    full.wires.forEach((w, k) => {
      const name = w.net >= 0 ? nets[w.net]?.name ?? "A net" : "A net";
      const how = w.c1 === w.c2
        ? `straight down column ${w.c1 + 1}, from row ${Math.min(w.r1, w.r2) + 1} to row ${Math.max(w.r1, w.r2) + 1}`
        : w.r1 === w.r2 ? `along row ${w.r1 + 1}, from column ${Math.min(w.c1, w.c2) + 1} to column ${Math.max(w.c1, w.c2) + 1}` : `slanted, from row ${w.r1 + 1} column ${w.c1 + 1} to row ${w.r2 + 1} column ${w.c2 + 1}`;
      lab.frames.push({ stage: 7, msg: `${name}: wire ${k + 1} of ${nWires}, ${how}.${k === 0 ? " Each wire is the shortest straight link between two free holes of its net that lies on no other wire and crosses no component." : ""}`, board: { ...full, wires: full.wires.slice(0, k + 1), hlNet: w.net >= 0 ? w.net : undefined } });
    });
    lab.frames.push({ stage: 7, msg: `Every net is joined and no wire lies on another. ${c.mess === 0 ? "Nothing is messy" : `${c.mess} wire${c.mess === 1 ? " is" : "s are"} still slanted, crossing or stacked`}.`, board: full });
  }
  const netOfPin = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));
  const c0 = chooser.chosen!;
  const anyLock = lockedColsCap !== undefined || lockedRowsCap !== undefined;
  if (c0.bad === 0 && !anyLock) {
    // under a locked dimension the board is a physical given: the harvest
    // would only drag edge-flush parts inward for no gain
    const full = compactPlacements(c0.virtual, componentDefs, netOfPin, c0.rows, c0.cols);
    if (full.removals > 0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds);
    if (lab && chooser.chosen !== c0) pushFin(`Lines that carry nothing are squeezed out and the board is routed again: ${full.removals} line${full.removals === 1 ? "" : "s"} gone.`);
  }
  // hard zero-mess rule: buy bus rows and channel columns until every
  // wire is vertical and crosses nothing; a locked dimension cannot grow
  // and locked parts must not shift, so under those the mess may remain
  const cCh = chooser.chosen!;
  if (chooser.chosen!.bad === 0 && !hasLocked) {
    insertWireChannels(chooser, componentDefs, {
      ...(lockedRowsCap !== undefined ? { maxRows: lockedRowsCap } : {}),
      ...(lockedColsCap !== undefined ? { maxCols: lockedColsCap } : {}),
    }, false, true);
  }
  if (lab && chooser.chosen !== cCh) pushFin("Wherever a wire would still have to slant, cross something or lie on another wire, the finish buys a blank row or column at the best place it can find and routes again, as often as it takes. That is what a straight, crossing-free board costs in area.");
  const cSl = chooser.chosen!;
  if (chooser.chosen!.bad === 0) repairSlantWires(chooser, routeBoard, componentDefs, netAssignments, new Set());
  if (lab && chooser.chosen !== cSl) pushFin("A last look at each wire that is not yet straight: the router tries to give it a column of its own by shifting what stands in the way.");
  // a line that carries nothing, or nothing but wires, is blank board the
  // user would buy: a channel the router did not use in the end, a wire
  // that would fit a column next to a part just as well, a connector
  // column pushed out by such a wire. Try to free each such line on its
  // own; the router finds the wires another line, and the chooser keeps a
  // try only if the board still routes as cleanly and rates better
  const cFree = chooser.chosen!;
  if (!anyLock && !hasLocked) {
    for (let round = 0; round < 24; round++) {
      const c1 = chooser.chosen!;
      if (c1.bad !== 0 || c1.mess !== 0) break;
      const partRows = new Set<number>(), partCols = new Set<number>();
      for (const c of c1.virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        let r1: number, r2: number, k1: number, k2: number;
        if (def.flexible) {
          const e = c.flexibleEndPos ?? c.boardPos;
          r1 = Math.min(c.boardPos.row, e.row); r2 = Math.max(c.boardPos.row, e.row);
          k1 = Math.min(c.boardPos.col, e.col); k2 = Math.max(c.boardPos.col, e.col);
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          r1 = b.minRow; r2 = b.maxRow; k1 = b.minCol; k2 = b.maxCol;
        }
        for (let r = r1; r <= r2; r++) partRows.add(r);
        for (let k = k1; k <= k2; k++) partCols.add(k);
      }
      for (const cut of c1.plan.cuts) {
        partRows.add(cut.row);
        partCols.add(cut.col);
        if (cut.kind !== "hole") partCols.add(cut.col + 1);
      }
      const tries: [number, boolean][] = [];
      for (let k = c1.cols - 1; k >= 0; k--) if (!partCols.has(k)) tries.push([k, true]);
      for (let r = c1.rows - 1; r >= 0; r--) if (!partRows.has(r)) tries.push([r, false]);
      let freed = false;
      for (const [line, isCol] of tries) {
        // every other line stays; only this one may go
        const keep = { rows: new Set<number>(), cols: new Set<number>() };
        for (let k = 0; k < c1.cols; k++) if (!isCol || k !== line) keep.cols.add(k);
        for (let r = 0; r < c1.rows; r++) if (isCol || r !== line) keep.rows.add(r);
        const again = compactPlacements(c1.virtual, componentDefs, netOfPin, c1.rows, c1.cols, 1, undefined, keep);
        if (again.removals === 0) continue;
        chooser.route(again.comps, again.rows, again.cols, c1.movedIds);
        if (chooser.chosen !== c1) { freed = true; break; }
      }
      if (!freed) break;
    }
  }
  if (lab && chooser.chosen !== cFree) pushFin("A line that carries nothing but a wire is board you would have to buy. Each one is offered back to the router on its own, and kept out whenever the wires find another way.");
  const ch = chooser.chosen!;
  const unplaceIds = [
    ...skipped.map((c) => c.id),
    ...components.filter((c) => !c.boardExcluded && !movedIds.has(c.id) && !skipped.some((s) => s.id === c.id)).map((c) => c.id),
  ];
  const issues: string[] = [];
  for (const c of skipped) issues.push(`${c.label ?? c.id} could not be planned`);
  if (ch.plan.unresolvedConflicts > 0) issues.push(`${ch.plan.unresolvedConflicts} strip conflicts remain`);
  if (lockedColsCap !== undefined && ch.cols > lockedColsCap) issues.push(`does not fit the locked ${lockedColsCap} columns (needs ${ch.cols})`);
  if (lockedRowsCap !== undefined && ch.rows > lockedRowsCap) issues.push(`does not fit the locked ${lockedRowsCap} rows (needs ${ch.rows})`);
  const stacked = options?.noWireStacking
    ? ch.plan.wires.filter((w, i) => wireStackDepth(w.from, w.to, ch.plan.wires.slice(0, i)) > 0).length
    : 0;
  if (ch.mess - stacked > 0) issues.push(`${ch.mess - stacked} wire${ch.mess - stacked === 1 ? "" : "s"} could not be made straight and crossing-free`);
  if (stacked > 0) issues.push(`${stacked} wire${stacked === 1 ? "" : "s"} still run on top of another wire`);
  const result: AutoLayoutResult = {
    placements: ch.virtual
      .filter((c) => movedIds.has(c.id) && c.boardPos)
      .map((c) => {
        const def = resolveComponentDef(c, componentDefs)!;
        return def.flexible
          ? { componentId: c.id, boardPos: c.boardPos!, flexibleEndPos: c.flexibleEndPos }
          : { componentId: c.id, boardPos: c.boardPos!, rotation: c.rotation };
      }),
    cuts: ch.plan.cuts,
    wires: ch.plan.wires,
    issues,
    quality: ch.plan.unresolvedConflicts * 100 + ch.plan.starvedNetIds.length + skipped.length * 2,
    starvedNetIds: ch.plan.starvedNetIds,
    boardSize: { rows: ch.rows, cols: ch.cols },
    unplaceIds,
  };
  let final: AutoLayoutResult;
  if (anyLock) {
    // locked dimensions come back EXACTLY as locked (the physical board);
    // only the free dimension is trimmed, and nothing is shifted
    let maxR = 0, maxC = 0, minR = Infinity, minC = Infinity;
    const see = (r: number, c: number) => {
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      minC = Math.min(minC, c);
    };
    for (const c of ch.virtual) {
      if (!c.boardPos || c.boardExcluded) continue;
      const def = resolveComponentDef(c, componentDefs);
      if (!def) continue;
      if (def.flexible) {
        const e = c.flexibleEndPos ?? c.boardPos;
        see(c.boardPos.row, c.boardPos.col);
        see(e.row, e.col);
      } else {
        const b = getComponentBounds(def, c.boardPos, c.rotation);
        see(b.minRow, b.minCol);
        see(b.maxRow, b.maxCol);
      }
    }
    for (const cut of ch.plan.cuts) see(cut.row, cut.col);
    for (const w of ch.plan.wires) {
      see(w.from.row, w.from.col);
      see(w.to.row, w.to.col);
    }
    if (!isFinite(minR)) { minR = 0; minC = 0; }
    // shift leading emptiness out of the FREE dimension only: the locked
    // dimension's frame is the physical board (shifting columns under a
    // locked width would drag edge-flush connectors off the rim), and
    // locked parts pin everything absolutely
    const shiftR = !hasLocked && lockedRowsCap === undefined ? minR : 0;
    const shiftC = !hasLocked && lockedColsCap === undefined ? minC : 0;
    if (shiftR > 0 || shiftC > 0) {
      const mv = (p: BoardPosition): BoardPosition => ({ row: p.row - shiftR, col: p.col - shiftC });
      result.placements = result.placements.map((pl) => ({
        ...pl, boardPos: mv(pl.boardPos),
        ...(pl.flexibleEndPos ? { flexibleEndPos: mv(pl.flexibleEndPos) } : {}),
      }));
      result.cuts = result.cuts.map((cut) => ({ ...cut, row: cut.row - shiftR, col: cut.col - shiftC }));
      result.wires = result.wires.map((w) => ({ from: mv(w.from), to: mv(w.to) }));
    }
    const rows = lockedRowsCap !== undefined ? Math.max(lockedRowsCap, maxR + 1) : maxR - shiftR + 1;
    const cols = lockedColsCap !== undefined ? Math.max(lockedColsCap, maxC + 1) : maxC - shiftC + 1;
    final = { ...result, boardSize: { rows, cols } };
  } else {
    const trimmed = trimResult(result, routeBoard, ch.virtual, componentDefs, hasLocked);
    final = { ...result, ...trimmed };
  }
  // purely visual: line the cuts up on shared columns (v2 does the same)
  if (final.quality === 0) {
    final = alignCuts(final, routeBoard, components, componentDefs);
    if (options?.drilledCutsOnly && final.boardSize) {
      // alignment may have slid a stuck knife cut next to a drillable hole
      const byPl = new Map(final.placements.map((p) => [p.componentId, p]));
      const virtual = components.map((c) => {
        const p = byPl.get(c.id);
        return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
      });
      const vBoard: Board = { ...board, rows: final.boardSize.rows, cols: final.boardSize.cols, cuts: [], wires: [] };
      final = { ...final, cuts: drillRemainingCuts(vBoard, virtual, componentDefs, netAssignments, final.cuts, final.wires) };
    }
  }
  if (lab && final.boardSize) {
    const byPl2 = new Map(final.placements.map((pl) => [pl.componentId, pl]));
    const virt = components.map((c) => {
      const pl = byPl2.get(c.id);
      return pl ? { ...c, boardPos: pl.boardPos, rotation: pl.rotation ?? c.rotation, flexibleEndPos: pl.flexibleEndPos } : c;
    });
    const knives = final.cuts.filter((k) => k.kind !== "hole").length;
    lab.frames.push({
      stage: 7,
      msg: `The board is trimmed to what it uses, and every cut that can be is turned into a drilled hole rather than a knife stroke between two holes, then lined up with the others in one column where possible. ${final.boardSize.rows} by ${final.boardSize.cols}, ${final.wires.length} link wire${final.wires.length === 1 ? "" : "s"}, ${final.cuts.length} cut${final.cuts.length === 1 ? "" : "s"}${knives ? `, ${knives} of them with a knife` : ", none of them with a knife"}. This is the board you get.`,
      board: lab.board(virt, final.boardSize.rows, final.boardSize.cols, final.cuts, final.wires),
    });
  }
  const price = priceResult(final, routeBoard, components, componentDefs, options?.drilledCutsOnly ?? false);
  const offAxis = final.wires.filter((w) => w.from.col !== w.to.col).length;
  const crossings = wireMessScore(final, comps, componentDefs).crossings;
  const overCap =
    (lockedColsCap !== undefined ? Math.max(0, (final.boardSize?.cols ?? 0) - lockedColsCap) : 0) +
    (lockedRowsCap !== undefined ? Math.max(0, (final.boardSize?.rows ?? 0) - lockedRowsCap) : 0);
  const score = (final.quality + overCap * 40) * 1e9 + (offAxis + crossings) * 1e4 + price;
  return { final, score };
}

// ── The repair finish: the decoder's board, kept ──
// The anneal scored an exact board: strips, cuts and wires. Taking that board
// as it is, and touching it only where the editor's rules say so, keeps what
// the anneal chose. The board is read off the skeleton's wiring, then:
// lines that carry no part, cut or wire end are harvested (cuts and wires
// move along, a wire through a removed row just gets shorter); a wire the
// editor would not draw, one lying on another wire or running over a body,
// moves to another column of its two strips, or gets a blank column of its
// own where none is free; a column left carrying nothing but wire ends is
// emptied the same way and harvested; a connector on the skeleton's rim
// slides out along its strip into a margin column that stayed. Then the
// passes that move no part: the trim, the cut alignment and the drill
// upgrade. What the editor's rules still find is reported back so the
// caller can route again.
type Wire = { from: BoardPosition; to: BoardPosition };

export function finishRepair(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  skeleton: Skeleton,
  options?: FinishOptions,
  lab?: FinishLab
): { final: AutoLayoutResult; score: number; ok: boolean } | null {
  const w = skeleton.wiring;
  if (!w) return null;
  const lockedColsCap = board.lockedCols ? board.cols : undefined;
  const lockedRowsCap = board.lockedRows ? board.rows : undefined;
  const anyLock = lockedColsCap !== undefined || lockedRowsCap !== undefined;
  const hasLocked = skeleton.placed.some((p) => p.locked);
  const skippedSet = new Set(skeleton.skippedIds);
  const skipped = components.filter((c) => skippedSet.has(c.id));
  const noStack = !!options?.noWireStacking;
  // the decoder's grid carries a blank margin on every free side
  const mRow = (w.rows - skeleton.rows) / 2;
  const mCol = (w.cols - skeleton.cols) / 2;
  const movedIds = new Set(skeleton.placed.map((p) => p.id));
  let virtual: Component[] = components.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0 as Rot }));
  const byId = new Map(virtual.map((c) => [c.id, c]));
  const shm = (p: BoardPosition): BoardPosition => ({ row: p.row + mRow, col: p.col + mCol });
  for (const p of skeleton.placed) {
    const c = byId.get(p.id)!;
    c.boardPos = shm(p.boardPos);
    c.rotation = p.rotation;
    if (p.flexibleEndPos) c.flexibleEndPos = shm(p.flexibleEndPos);
    if (p.locked) c.locked = true;
  }
  let cuts: AutoLayoutResult["cuts"] = w.cuts.map((k) => ({ row: k.row, col: k.col, kind: k.kind === "hole" ? "hole" : "between" }));
  let wires: Wire[] = w.wires.map((x) => ({ from: { row: x.r1, col: x.c1 }, to: { row: x.r2, col: x.c2 } }));
  let rows = w.rows, cols = w.cols;
  const free = !anyLock && !hasLocked;
  const netOfPin = new Map(netAssignments.map((a) => [pinKey(a.componentId, a.pinId), a.netId]));

  // ── the parts' own rules (the compaction's), so a change may add no violation ──
  const violations = (comps: Component[]): Set<string> => {
    const out = new Set<string>();
    const flex: { id: string; prof: ReturnType<typeof flexProfile>; p1: BoardPosition; p2: BoardPosition; lines: number; nets: (string | undefined)[] }[] = [];
    const rig: { id: string; body: ReturnType<typeof rigidGeometry>["body"]; reach?: ReturnType<typeof rigidGeometry>["reach"]; lines: number; pins: { row: number; col: number; net?: string }[] }[] = [];
    for (const c of comps) {
      if (!c.boardPos || c.boardExcluded) continue;
      const def = resolveComponentDef(c, componentDefs);
      if (!def) continue;
      if (def.flexible) {
        const p2 = c.flexibleEndPos ?? c.boardPos;
        flex.push({ id: c.id, prof: flexProfile(def), p1: c.boardPos, p2, lines: def.clearance ?? 0, nets: [def.pins[0], def.pins[1]].map((p) => (p ? netOfPin.get(pinKey(c.id, p.id)) : undefined)) });
      } else {
        const g = rigidGeometry(def, c.boardPos, c.rotation);
        rig.push({ id: c.id, body: g.body, reach: g.reach, lines: def.clearance ?? 0, pins: getRotatedPinPositions(def, c.boardPos, c.rotation).map((p) => ({ row: p.row, col: p.col, net: netOfPin.get(pinKey(c.id, p.pinId)) })) });
      }
    }
    for (let i = 0; i < flex.length; i++) {
      const a = flex[i];
      for (let j = i + 1; j < flex.length; j++) {
        const b = flex[j];
        if (segmentsIntersect(a.p1, a.p2, b.p1, b.p2)) out.add(`ffx:${a.id}:${b.id}`);
        if (flexBodiesClash(a.prof, a.p1, a.p2, b.prof, b.p1, b.p2)) out.add(`ffc:${a.id}:${b.id}`);
      }
      for (const r of rig) {
        if (flexClashesRect({ ...a.prof, lines: Math.max(a.prof.lines, r.lines) }, a.p1, a.p2, r.body)) out.add(`fr:${a.id}:${r.id}`);
        if (r.reach && flexClashesRect({ ...a.prof, lines: 0 }, a.p1, a.p2, r.reach)) out.add(`fh:${a.id}:${r.id}`);
      }
    }
    for (let i = 0; i < rig.length; i++) {
      for (let j = i + 1; j < rig.length; j++) {
        const a = rig[i], b = rig[j];
        if (bodyRectsClash(a.body, b.body, Math.max(a.lines, b.lines))) out.add(`rr:${a.id}:${b.id}`);
        if ((a.reach && bodyRectsClash(a.reach, b.body)) || (b.reach && bodyRectsClash(b.reach, a.body)) || (a.reach && b.reach && bodyRectsClash(a.reach, b.reach))) out.add(`rh:${a.id}:${b.id}`);
      }
    }
    const owner = new Map<string, { id: string; net?: string }>();
    for (const r of rig) for (const p of r.pins) owner.set(holeKey(p.row, p.col), { id: r.id, net: p.net });
    for (const a of flex) { owner.set(holeKey(a.p1.row, a.p1.col), { id: a.id, net: a.nets[0] }); owner.set(holeKey(a.p2.row, a.p2.col), { id: a.id, net: a.nets[1] }); }
    for (const a of flex) for (const h of corridorHoles(a.p1, a.p2)) { const o = owner.get(holeKey(h.row, h.col)); if (o && o.id !== a.id) out.add(`co:${a.id}:${o.id}`); }
    const byRow = new Map<number, { col: number; id: string; net?: string }[]>();
    for (const [k, o] of owner) { const [r, c] = k.split(",").map(Number); if (!byRow.has(r)) byRow.set(r, []); byRow.get(r)!.push({ col: c, ...o }); }
    for (const [, ps] of byRow) {
      ps.sort((a, b) => a.col - b.col);
      for (let i = 1; i < ps.length; i++) if (ps[i].net !== ps[i - 1].net && ps[i].col - ps[i - 1].col < 2) out.add(`cg:${ps[i - 1].id}:${ps[i].id}`);
    }
    return out;
  };
  const baseViol = violations(virtual);
  const geometryOk = (comps: Component[]) => { for (const v of violations(comps)) if (!baseViol.has(v)) return false; return true; };
  const priceNow = () => priceResult({ placements: virtual.filter((c) => c.boardPos && movedIds.has(c.id)).map((c) => ({ componentId: c.id, boardPos: c.boardPos!, rotation: c.rotation, flexibleEndPos: c.flexibleEndPos })), cuts, wires, issues: [], quality: 0, starvedNetIds: [], boardSize: { rows, cols }, unplaceIds: [] }, { ...board, rows, cols }, components, componentDefs, options?.drilledCutsOnly ?? false);

  // ── the board's rules, read afresh after every change of shape ──
  let obstacles: WireObstacles = { rects: [], bodies: [] };
  let occupied = new Set<string>();
  let ends = new Map<string, number>();
  let segments: ReturnType<typeof computeStripSegments> = [];
  const refresh = () => {
    obstacles = { rects: [], bodies: [] };
    for (const c of virtual) {
      if (!c.boardPos || c.boardExcluded) continue;
      const def = resolveComponentDef(c, componentDefs);
      if (!def) continue;
      if (def.flexible) {
        const [p1, p2] = getFlexiblePinPositions(c, def);
        if (p1 && p2) obstacles.bodies.push(flexWireObstacle(def, p1, p2));
      } else obstacles.rects.push(rigidBody(def, c.boardPos, c.rotation));
    }
    const segBoard: Board = { ...board, rows, cols, cuts, wires: [] };
    const pins = collectBoardPins(segBoard, virtual, componentDefs, netAssignments);
    occupied = collectOccupiedHoles(segBoard, virtual, componentDefs, pins);
    for (const k of cuts) if (k.kind === "hole") occupied.add(holeKey(k.row, k.col));
    ends = new Map();
    for (const x of wires) for (const p of [x.from, x.to]) ends.set(holeKey(p.row, p.col), (ends.get(holeKey(p.row, p.col)) ?? 0) + 1);
    segments = computeStripSegments(segBoard, virtual, componentDefs, netAssignments);
  };
  const segAt = (r: number, c: number) => segments.find((sg) => sg.row === r && sg.startCol <= c && c <= sg.endCol);
  const crosses = (a: BoardPosition, b: BoardPosition) =>
    obstacles.rects.some((r) => segmentIntersectsRect(a, b, r)) || obstacles.bodies.some((bd) => wireCrossesBody(a, b, bd));
  const badWire = (a: BoardPosition, b: BoardPosition, others: Wire[]) => crosses(a, b) || (noStack && wireStackDepth(a, b, others) > 0);
  const holeTaken = (p: BoardPosition) => occupied.has(holeKey(p.row, p.col)) || ends.has(holeKey(p.row, p.col));
  const moveEnds = (from: Wire, to: Wire) => {
    for (const p of [from.from, from.to]) { const k = holeKey(p.row, p.col); const n = (ends.get(k) ?? 1) - 1; if (n > 0) ends.set(k, n); else ends.delete(k); }
    for (const p of [to.from, to.to]) ends.set(holeKey(p.row, p.col), (ends.get(holeKey(p.row, p.col)) ?? 0) + 1);
  };
  // another column of the same two strips for wire i, nearest first; `avoid` a column to empty
  const repick = (i: number, avoid = -1): boolean => {
    const x = wires[i];
    if (x.from.col !== x.to.col) return false;
    const others = wires.filter((_, j) => j !== i);
    const sa = segAt(x.from.row, x.from.col), sb = segAt(x.to.row, x.to.col);
    if (!sa || !sb) return false;
    const lo = Math.max(sa.startCol, sb.startCol), hi = Math.min(sa.endCol, sb.endCol);
    const cands: number[] = [];
    for (let c = lo; c <= hi; c++) if (c !== x.from.col && c !== avoid) cands.push(c);
    cands.sort((p, q) => Math.abs(p - x.from.col) - Math.abs(q - x.from.col) || p - q);
    for (const c of cands) {
      const a = { row: x.from.row, col: c }, b = { row: x.to.row, col: c };
      if (holeTaken(a) || holeTaken(b) || badWire(a, b, others)) continue;
      moveEnds(x, { from: a, to: b });
      wires[i] = { from: a, to: b };
      return true;
    }
    return false;
  };
  // a blank column of its own for wire i, inside both strips, splitting no
  // package, no knife cut and no flexible part that spans the wire's rows
  const channel = (i: number): boolean => {
    const x = wires[i];
    if (!free || x.from.col !== x.to.col) return false;
    const sa = segAt(x.from.row, x.from.col), sb = segAt(x.to.row, x.to.col);
    if (!sa || !sb) return false;
    const r1 = Math.min(x.from.row, x.to.row), r2 = Math.max(x.from.row, x.to.row);
    const lo = Math.max(sa.startCol, sb.startCol) + 1, hi = Math.min(sa.endCol, sb.endCol);
    const cands: number[] = [];
    for (let at = lo; at <= hi; at++) cands.push(at);
    cands.sort((p, q) => Math.abs(p - x.from.col) - Math.abs(q - x.from.col) || p - q);
    for (const at of cands) {
      if (cuts.some((k) => k.kind !== "hole" && k.col === at - 1)) continue;
      let blocked = false;
      for (const c of virtual) {
        if (!c.boardPos || c.boardExcluded) continue;
        const def = resolveComponentDef(c, componentDefs);
        if (!def) continue;
        if (def.flexible) {
          const p2 = c.flexibleEndPos ?? c.boardPos;
          const cLo = Math.min(c.boardPos.col, p2.col), cHi = Math.max(c.boardPos.col, p2.col);
          if (!(cLo < at && at <= cHi)) continue;
          const rLo = Math.min(c.boardPos.row, p2.row), rHi = Math.max(c.boardPos.row, p2.row);
          if (rLo <= r2 && r1 <= rHi) { blocked = true; break; }
          if (Math.hypot(rHi - rLo, cHi - cLo + 1) > spanLimits(def).max + 1e-6) { blocked = true; break; }
        } else {
          const b = getComponentBounds(def, c.boardPos, c.rotation);
          if (b.minCol < at && at <= b.maxCol) { blocked = true; break; }
        }
      }
      if (blocked) continue;
      // a rim connector keeps its place when the column goes in (insertLine
      // pins it), so a connector standing at `at` on the wire's rows would
      // still be there: not a free column for this wire
      const pinnedHere = virtual.some((c) => {
        if (!c.boardPos || c.boardExcluded) return false;
        const def = resolveComponentDef(c, componentDefs);
        if (!def || def.category !== "connector") return false;
        const b = getComponentBounds(def, c.boardPos, c.rotation);
        return b.minCol === b.maxCol && b.minCol === at && b.minRow <= r2 && r1 <= b.maxRow;
      });
      if (pinnedHere) continue;
      const grown = insertLine(virtual, componentDefs, true, at, true);
      if (!geometryOk(grown)) continue;
      virtual = grown;
      cuts = cuts.map((k) => (k.col >= at ? { ...k, col: k.col + 1 } : k));
      wires = wires.map((y) => ({ from: y.from.col >= at ? { row: y.from.row, col: y.from.col + 1 } : y.from, to: y.to.col >= at ? { row: y.to.row, col: y.to.col + 1 } : y.to }));
      cols++;
      wires[i] = { from: { row: x.from.row, col: at }, to: { row: x.to.row, col: at } };
      refresh();
      return true;
    }
    return false;
  };
  const harvest = (): boolean => {
    if (!free) return false;
    const keep = { rows: new Set<number>(), cols: new Set<number>() };
    for (const k of cuts) { keep.rows.add(k.row); keep.cols.add(k.col); if (k.kind !== "hole") keep.cols.add(k.col + 1); }
    for (const x of wires) for (const p of [x.from, x.to]) { keep.rows.add(p.row); keep.cols.add(p.col); }
    const h = compactPlacements(virtual, componentDefs, netOfPin, rows, cols, Infinity, undefined, keep);
    if (h.removals === 0) return false;
    const mv = (p: BoardPosition): BoardPosition => ({ row: h.rowMap[p.row], col: h.colMap[p.col] });
    cuts = cuts.map((k) => ({ ...k, row: h.rowMap[k.row], col: h.colMap[k.col] }));
    wires = wires.map((x) => ({ from: mv(x.from), to: mv(x.to) }));
    virtual = h.comps;
    rows = h.rows; cols = h.cols;
    return true;
  };

  const pushR = (msg: string) => { if (lab) lab.frames.push({ stage: 7, msg, board: lab.board(virtual, rows, cols, cuts, wires) }); };
  // ── 1. harvest what the decoder's grid kept blank ──
  const harvested = harvest();
  refresh();
  if (harvested) pushR("The repair keeps the decoder's cuts and wires and touches only what the editor's rules reject. First every line that carries no part, no cut and no wire end is squeezed out, and the cuts and wires move down with the grid.");
  // ── 2. every wire the editor would not draw: another column, or a channel ──
  let mended = 0;
  for (let i = 0; i < wires.length; i++) {
    const x = wires[i];
    if (!badWire(x.from, x.to, wires.filter((_, j) => j !== i))) continue;
    if (repick(i) || channel(i)) mended++;
  }
  if (mended) pushR(`The decoder has no rule against a wire lying on another or crossing a part, so ${mended} wire${mended === 1 ? "" : "s"} here would not be drawn that way. Each one moves to another column of the same two strips, or gets a blank column of its own. Which strips a wire joins never changes.`);
  // ── 3. a column carrying nothing but wire ends: empty it and harvest ──
  let emptied = 0;
  if (free) {
    for (let c = cols - 1; c >= 0; c--) {
      let carries = false;
      for (const comp of virtual) {
        if (!comp.boardPos || comp.boardExcluded) continue;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def) continue;
        if (def.flexible) { const e = comp.flexibleEndPos ?? comp.boardPos; if (comp.boardPos.col === c || e.col === c) { carries = true; break; } }
        else { const b = getComponentBounds(def, comp.boardPos, comp.rotation); if (b.minCol <= c && c <= b.maxCol) { carries = true; break; } }
      }
      if (carries || cuts.some((k) => k.col === c || (k.kind !== "hole" && k.col + 1 === c))) continue;
      const here = wires.map((x, i) => (x.from.col === c || x.to.col === c ? i : -1)).filter((i) => i >= 0);
      if (here.length === 0) continue;
      const outer = c === 0 || c === cols - 1;
      const rimBeside = outer && virtual.some((comp) => {
        if (!comp.boardPos || comp.boardExcluded) return false;
        const def = resolveComponentDef(comp, componentDefs);
        if (!def || def.category !== "connector" || def.flexible) return false;
        const b = getComponentBounds(def, comp.boardPos, comp.rotation);
        return c === 0 ? b.minCol === 1 : b.maxCol === cols - 2;
      });
      const before = { virtual, cuts, wires, rows, cols, ends: new Map(ends), price: priceNow() };
      let all = true;
      for (const i of here) if (!repick(i, c) && !(rimBeside && channel(i))) { all = false; break; }
      if (all && harvest()) { refresh(); if (priceNow() < before.price - 1e-9) { emptied++; continue; } }
      virtual = before.virtual; cuts = before.cuts; wires = before.wires; rows = before.rows; cols = before.cols;
      refresh();
    }
  }
  if (emptied) pushR(`A column that carries nothing but the ends of wires is board you would have to buy. ${emptied} of them ${emptied === 1 ? "is" : "are"} emptied and squeezed out, kept only where the board comes out cheaper.`);
  // ── 4. a connector on the rim slides out along its strip ──
  let slid = 0;
  if (free) {
    for (const comp of virtual) {
      if (!comp.boardPos || comp.boardExcluded || comp.locked) continue;
      const def = resolveComponentDef(comp, componentDefs);
      if (!def || def.category !== "connector" || def.flexible) continue;
      let b = getComponentBounds(def, comp.boardPos, comp.rotation);
      if (b.maxCol !== b.minCol) continue;
      const pinRows = getRotatedPinPositions(def, comp.boardPos, comp.rotation).map((p) => p.row);
      for (const dir of [-1, 1] as const) {
        // toward the nearer edge only
        if ((dir < 0 ? b.minCol : cols - 1 - b.maxCol) > (dir < 0 ? cols - 1 - b.maxCol : b.minCol)) continue;
        for (;;) {
          const nc = b.minCol + dir;
          if (nc < 0 || nc >= cols) break;
          let ok = true;
          for (let r = b.minRow; r <= b.maxRow && ok; r++) {
            const p = { row: r, col: nc };
            if (holeTaken(p)) ok = false;
            else if (pinRows.includes(r) && segAt(r, nc) !== segAt(r, b.minCol)) ok = false;
            else if (wires.some((x) => x.from.col === nc && Math.min(x.from.row, x.to.row) <= r && r <= Math.max(x.from.row, x.to.row))) ok = false;
          }
          if (!ok) break;
          const at: BoardPosition = { row: comp.boardPos.row, col: comp.boardPos.col + dir };
          const moved: Component = { ...comp, boardPos: at };
          const moved2 = virtual.map((c) => (c.id === comp.id ? moved : c));
          if (!geometryOk(moved2)) break;
          virtual = moved2;
          comp.boardPos = at;
          slid++;
          b = getComponentBounds(def, at, comp.rotation);
          refresh();
        }
      }
    }
  }

  if (slid) pushR(`${slid === 1 ? "A connector" : `${slid} connectors`} on the rim slide${slid === 1 ? "s" : ""} outward along their own strip, into the margin the decoder left beside them.`);
  // ── the editor's rules on what is left ──
  const routeBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
  refresh();
  const connectivity = computeConnectivity(segments, wires.map((x, i) => ({ id: `w${i}`, ...x })));
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(nets, netAssignments, segments, connectivity, virtual, componentDefs);
  const unplaceIds = [
    ...skipped.map((c) => c.id),
    ...components.filter((c) => !c.boardExcluded && !movedIds.has(c.id) && !skipped.some((sk) => sk.id === c.id)).map((c) => c.id),
  ];
  const issues: string[] = [];
  for (const c of skipped) issues.push(`${c.label ?? c.id} could not be planned`);
  if (conflicts > 0) issues.push(`${conflicts} strip conflicts remain`);
  const result: AutoLayoutResult = {
    placements: virtual
      .filter((c) => movedIds.has(c.id) && c.boardPos)
      .map((c) => {
        const def = resolveComponentDef(c, componentDefs)!;
        return def.flexible
          ? { componentId: c.id, boardPos: c.boardPos!, flexibleEndPos: c.flexibleEndPos }
          : { componentId: c.id, boardPos: c.boardPos!, rotation: c.rotation };
      }),
    cuts,
    wires,
    issues,
    quality: conflicts * 100 + incomplete.length + skipped.length * 2,
    starvedNetIds: incomplete.map((n) => n.netId),
    boardSize: { rows, cols },
    unplaceIds,
  };
  // the passes that move no part and route no wire
  let final: AutoLayoutResult = anyLock ? result : { ...result, ...trimResult(result, routeBoard, virtual, componentDefs, hasLocked) };
  if (final.quality === 0) {
    final = alignCuts(final, routeBoard, components, componentDefs);
    if (options?.drilledCutsOnly && final.boardSize) {
      const byPl = new Map(final.placements.map((p) => [p.componentId, p]));
      const virt = components.map((c) => {
        const p = byPl.get(c.id);
        return p ? { ...c, boardPos: p.boardPos, rotation: p.rotation ?? c.rotation, flexibleEndPos: p.flexibleEndPos } : c;
      });
      const vBoard: Board = { ...board, rows: final.boardSize.rows, cols: final.boardSize.cols, cuts: [], wires: [] };
      final = { ...final, cuts: drillRemainingCuts(vBoard, virt, componentDefs, netAssignments, final.cuts, final.wires) };
    }
  }
  if (lab && final.boardSize) {
    const byPl2 = new Map(final.placements.map((pl) => [pl.componentId, pl]));
    const virt = components.map((c) => {
      const pl = byPl2.get(c.id);
      return pl ? { ...c, boardPos: pl.boardPos, rotation: pl.rotation ?? c.rotation, flexibleEndPos: pl.flexibleEndPos } : c;
    });
    const knives = final.cuts.filter((k) => k.kind !== "hole").length;
    lab.frames.push({
      stage: 7,
      msg: `Trimmed, with the cuts lined up and drilled where they can be. ${final.boardSize.rows} by ${final.boardSize.cols}, ${final.wires.length} link wire${final.wires.length === 1 ? "" : "s"}, ${final.cuts.length} cut${final.cuts.length === 1 ? "" : "s"}${knives ? `, ${knives} of them with a knife` : ", none of them with a knife"}. Every wire here is one the annealer itself chose.`,
      board: lab.board(virt, final.boardSize.rows, final.boardSize.cols, final.cuts, final.wires),
    });
  }
  const price = priceResult(final, routeBoard, components, componentDefs, options?.drilledCutsOnly ?? false);
  const offAxis = final.wires.filter((x) => x.from.col !== x.to.col).length;
  const crossings = wireMessScore(final, virtual, componentDefs).crossings;
  const stacked = noStack ? final.wires.filter((x, i) => wireStackDepth(x.from, x.to, final.wires.slice(0, i)) > 0).length : 0;
  const mess = offAxis + crossings + stacked;
  if (mess - stacked > 0) issues.push(`${mess - stacked} wire${mess - stacked === 1 ? "" : "s"} could not be made straight and crossing-free`);
  if (stacked > 0) issues.push(`${stacked} wire${stacked === 1 ? "" : "s"} still run on top of another wire`);
  const overCap =
    (lockedColsCap !== undefined ? Math.max(0, (final.boardSize?.cols ?? 0) - lockedColsCap) : 0) +
    (lockedRowsCap !== undefined ? Math.max(0, (final.boardSize?.rows ?? 0) - lockedRowsCap) : 0);
  const score = (final.quality + overCap * 40) * 1e9 + mess * 1e4 + price;
  return { final, score, ok: final.quality === 0 && mess === 0 && overCap === 0 && geometryOk(virtual) };
}
