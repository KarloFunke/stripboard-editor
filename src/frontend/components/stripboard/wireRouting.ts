import { BoardPosition, Cut, Net } from "@/types";
import { StripSegment } from "./stripSegments";
import { BoardPin } from "./boardPins";
import { WireObstacleIndex } from "./flexGeometry";
import { activeRouteWasm } from "./v5wasm/routeWasm";

/**
 * Connect each net's disconnected strip groups with jumper wires (Prim-style
 * MST: always join the nearest pair of free holes). Wires may share endpoint
 * holes but must not run collinearly on top of another wire — unless that is
 * the only way to complete the net. The router is v5wasm/route.c, installed
 * once per worker or page (setRouteWasm) before the first route.
 */
export function deriveWires(
  segments: StripSegment[],
  groups: { segmentIndices: number[] }[],
  nets: Net[],
  pins: BoardPin[],
  occupied: Set<string>,
  existingWires: { from: BoardPosition; to: BoardPosition }[],
  reserveNets: Set<string>,
  obstacleIndex: WireObstacleIndex,
  issues: string[],
  starvedNetIds: string[],
  starvedPinPositions: BoardPosition[],
  allowSharedJoints: boolean,
  skipRelays = false,
  // Drilled-cuts-only mode: a donated tail is severed by DRILLING OUT the
  // tail hole next to the donor's pins rather than cutting the copper
  // beside it. The relay runs on the rest of the tail, which stays intact,
  // so the mode keeps its strongest off-axis repair.
  drillTailRelays = false,
  // No-stacking mode: any wire on top of another is priced as a last
  // resort (like strict mess), so a free channel is taken whenever one exists
  noWireStacking = false
): {
  wires: { from: BoardPosition; to: BoardPosition }[];
  extraCuts: Cut[];
  wireMess: number;
  sharedJoints: number;
} {
  const router = activeRouteWasm();
  if (!router) throw new Error("the wire router is not loaded (v5wasm/routeWasm setRouteWasm)");
  const out = router.route(segments, groups, nets, pins, occupied, existingWires, reserveNets, obstacleIndex,
    allowSharedJoints, skipRelays, drillTailRelays, noWireStacking);
  issues.push(...out.issues);
  starvedNetIds.push(...out.starvedNetIds);
  starvedPinPositions.push(...out.starvedPinPositions);
  return { wires: out.wires, extraCuts: out.extraCuts, wireMess: out.wireMess, sharedJoints: out.sharedJoints };
}
