import { Component, ComponentDef, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds } from "../boardLayout";
import {
  WireObstacles,
  segmentIntersectsRect,
  segmentsIntersect,
  wireExtraLength,
} from "../flexGeometry";
import { AutoLayoutResult } from "../layoutTypes";

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
  for (const w of result.wires) {
    mess += (w.from.col !== w.to.col ? 1 : 0) + wireExtraLength(w.from, w.to, obstacles);
    for (const rect of obstacles.rects) {
      if (segmentIntersectsRect(w.from, w.to, rect)) crossings++;
    }
    for (const b of obstacles.bodies) {
      if (segmentsIntersect(w.from, w.to, b.p1, b.p2)) crossings++;
    }
  }
  return { mess, crossings };
}
