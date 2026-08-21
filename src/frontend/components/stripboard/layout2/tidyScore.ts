import { Component, ComponentDef, Cut, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { holeKey } from "../keys";
import { getComponentBounds, getRotatedPinPositions } from "../boardLayout";
import {
  WireObstacles,
  segmentIntersectsRect,
  segmentsIntersect,
  wireExtraLength,
  wireStackDepth,
  wireStackPenalty,
} from "../flexGeometry";
import { AutoLayoutResult } from "../layoutTypes";

// The price of one board cell, in the objective's common currency (a hole
// of wire and a hole of wire mess cost 1). At 1 the original calibration
// holds: density must not buy ugly wires, but a blank channel column costs
// its full height in cells. Below 1, board space gets cheaper relative to
// everything wire-shaped, so channel insertions, relay rows and bus lanes
// pay for themselves more often — the "roomier boards solder easier"
// preference. Used by the chooser's candidate cost and the finished-board
// rating alike, so construction and the final pick agree; the aspect
// penalty stays at full price so cheap cells don't buy ribbon shapes.
export const AREA_WEIGHT = 0.35;

// IC-like rigids (>= 4 physical pins) pin their nets to fixed footprint
// geometry; a net joining two of them cannot be absorbed by any flexible
// part. The count of such joins predicts residual wire mess (corpus knee
// at 0 -> 1, escalation with count), so it gates the IC-channel treatment.
export const IC_MIN_PINS = 4;
export function rigidJoinsOf(components: Component[], componentDefs: ComponentDef[], netAssignments: NetAssignment[]): number {
  const icIds = new Set(
    components
      .filter((c) => {
        if (c.boardExcluded) return false;
        const d = resolveComponentDef(c, componentDefs);
        return !!d && !d.flexible && d.pins.length >= IC_MIN_PINS;
      })
      .map((c) => c.id)
  );
  const perNet = new Map<string, Set<string>>();
  for (const a of netAssignments) {
    if (!icIds.has(a.componentId)) continue;
    if (!perNet.has(a.netId)) perNet.set(a.netId, new Set());
    perNet.get(a.netId)!.add(a.componentId);
  }
  let joins = 0;
  for (const s of perNet.values()) joins += s.size - 1;
  return joins;
}

// Drilled-cuts-only pricing: between-cuts that no placement can remove are
// exempt. A cut flanked by pins on BOTH sides separates directly adjacent
// pins (of one footprint's pin row) — the knife cut is physically forced
// there, so pricing it would only distort every comparison. `comps` must
// carry the candidate's own board positions.
export function avoidableBetweenCuts(cuts: Cut[], comps: Component[], componentDefs: ComponentDef[]): number {
  if (!cuts.some((c) => c.kind !== "hole")) return 0;
  const pinHoles = new Set<string>();
  for (const c of comps) {
    if (!c.boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) {
      pinHoles.add(holeKey(c.boardPos.row, c.boardPos.col));
      const p2 = c.flexibleEndPos ?? c.boardPos;
      pinHoles.add(holeKey(p2.row, p2.col));
    } else {
      for (const p of getRotatedPinPositions(def, c.boardPos, c.rotation)) {
        pinHoles.add(holeKey(p.row, p.col));
      }
    }
  }
  return cuts.reduce((n, cut) => {
    if (cut.kind === "hole") return n;
    const forced =
      pinHoles.has(holeKey(cut.row, cut.col)) && pinHoles.has(holeKey(cut.row, cut.col + 1));
    return n + (forced ? 0 : 1);
  }, 0);
}

// Visual wire mess of a finished result on its solved positions: off-axis
// wires plus the priced part crossings. Judges the tidy pass.
export function wireMessScore(
  result: AutoLayoutResult,
  components: Component[],
  componentDefs: ComponentDef[]
): { mess: number; crossings: number } {
  const byId = new Map(result.placements.map((p) => [p.componentId, p]));
  const obstacles: WireObstacles = { rects: [], bodies: [] };
  for (const c of components) {
    const p = byId.get(c.id);
    const boardPos = p?.boardPos ?? c.boardPos;
    if (!boardPos || c.boardExcluded) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    if (def.flexible) obstacles.bodies.push({ p1: boardPos, p2: p?.flexibleEndPos ?? c.flexibleEndPos ?? boardPos });
    else obstacles.rects.push(getComponentBounds(def, boardPos, p?.rotation ?? c.rotation));
  }
  let mess = 0;
  let crossings = 0;
  result.wires.forEach((w, i) => {
    mess += (w.from.col !== w.to.col ? 1 : 0) + wireExtraLength(w.from, w.to, obstacles);
    // Channel stacking, priced incrementally in wire order — the same
    // escalation the router pays, so candidates that crowd a channel lose
    // here too (rescue rate: a finished board is past the hard cap).
    mess += wireStackPenalty(wireStackDepth(w.from, w.to, result.wires.slice(0, i)), true);
    for (const rect of obstacles.rects) {
      if (segmentIntersectsRect(w.from, w.to, rect)) crossings++;
    }
    for (const b of obstacles.bodies) {
      if (segmentsIntersect(w.from, w.to, b.p1, b.p2)) crossings++;
    }
  });
  return { mess, crossings };
}
