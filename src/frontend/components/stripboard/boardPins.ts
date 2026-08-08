import { holeKey, pinKey } from "./keys";
import { Board, Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import {
  getComponentPinPositions,
  getFlexiblePinPositions,
  getRotatedBodyCells,
} from "./boardLayout";
import { bodyStyle } from "./componentGlyphs";
import { corridorHoles } from "./flexGeometry";
import { boardTopology, hasHole } from "./boardTopology";

export interface BoardPin {
  row: number;
  col: number;
  // Net id for assigned pins. Unassigned pins get a unique key so they are
  // isolated with cuts: a floating pin silently tied to a net's strip would
  // change the circuit relative to the schematic.
  netKey: string;
  netId: string | null;
}

/** Collect every placed, on-board pin with its net key */
export function collectBoardPins(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[]
): BoardPin[] {
  const pins: BoardPin[] = [];
  const topo = boardTopology(board);
  const netOfPin = new Map<string, string>();
  for (const a of netAssignments) {
    netOfPin.set(pinKey(a.componentId, a.pinId), a.netId);
  }
  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    for (const pin of getComponentPinPositions(comp, def)) {
      if (pin.row < 0 || pin.row >= board.rows || pin.col < 0 || pin.col >= board.cols) continue;
      if (!topo.plain && !hasHole(topo, pin.row, pin.col)) continue;
      const netId = netOfPin.get(pinKey(comp.id, pin.pinId));
      pins.push({
        row: pin.row,
        col: pin.col,
        netKey: netId ?? `nc:${comp.id}:${pin.pinId}`,
        netId: netId ?? null,
      });
    }
  }
  return pins;
}

/**
 * Parts whose under-body holes stay reachable for wire endpoints, because
 * they stand on header sockets. Exactly the defs that render as a board on
 * headers (bodyStyle "board"): the visual promise and the solder physics
 * must agree. A former shape fallback (wide pin span, header-scale pin
 * count) also matched user-built wide DIP-style ICs, which sit flat on the
 * board — the router soldered wires under them.
 */
function standsOnHeaders(def: ComponentDef): boolean {
  return bodyStyle(def) === "board";
}

/**
 * Holes that cannot take a jumper endpoint: component pins, body cells
 * (including everything under an IC), flexible-component body corridors,
 * and drilled-out holes. Wire endpoints do NOT block: several wires may
 * share one hole (daisy chains), they just may not run on top of each other.
 */
export function collectOccupiedHoles(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  pins: BoardPin[]
): Set<string> {
  const occupied = new Set<string>();

  for (const pin of pins) {
    occupied.add(holeKey(pin.row, pin.col));
  }

  for (const comp of components) {
    if (!comp.boardPos || comp.boardExcluded) continue;
    const def = resolveComponentDef(comp, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      // Block the corridor along the body line (handles diagonal placements;
      // for a vertical part this is exactly the holes between the pins).
      const [p1, p2] = getFlexiblePinPositions(comp, def);
      if (!p1 || !p2) continue;
      for (const hole of corridorHoles(p1, p2)) {
        occupied.add(holeKey(hole.row, hole.col));
      }
    } else if (!standsOnHeaders(def)) {
      // Flat-bodied rigids (DIPs, TO-92s) sit on the board and their body
      // holes are unreachable. Module breakout boards stand on header
      // sockets: the holes under them stay solderable, so only their pins
      // block wire endpoints — locked ESP32-class modules at a board edge
      // are unroutable otherwise, and humans do solder there.
      for (const cell of getRotatedBodyCells(def, comp.boardPos, comp.rotation)) {
        occupied.add(holeKey(cell.row, cell.col));
      }
    }
  }

  for (const cut of board.cuts) {
    if (cut.kind === "hole") occupied.add(holeKey(cut.row, cut.col));
  }

  // Positions the board simply has no hole at — a mounting-hole corner, the
  // material a snappable board is scored along. Nothing can be soldered
  // there, so they block exactly like a drilled hole.
  const topo = boardTopology(board);
  if (!topo.plain) {
    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        if (!hasHole(topo, row, col)) occupied.add(holeKey(row, col));
      }
    }
  }

  return occupied;
}
