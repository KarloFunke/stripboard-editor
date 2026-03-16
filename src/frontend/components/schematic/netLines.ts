import { Component, ComponentDef, Net, NetAssignment, PinDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";

interface PinPoint {
  x: number;
  y: number;
  componentId: string;
  pinId: string;
}

export interface NetLine {
  netId: string;
  color: string;
  edges: { x1: number; y1: number; x2: number; y2: number }[];
}

const PIN_SPACING = 24;
const PADDING_X = 16;
const PADDING_TOP = 16;

/**
 * Compute MST-based lines for each net.
 * Uses Prim's algorithm to find minimum spanning tree of pin positions.
 */
export function computeNetLines(
  nets: Net[],
  netAssignments: NetAssignment[],
  components: Component[],
  componentDefs: ComponentDef[]
): NetLine[] {
  const result: NetLine[] = [];

  for (const net of nets) {
    const assignments = netAssignments.filter((a) => a.netId === net.id);
    if (assignments.length < 2) continue;

    // Collect pin screen positions
    const points: PinPoint[] = [];
    for (const assignment of assignments) {
      const comp = components.find((c) => c.id === assignment.componentId);
      if (!comp) continue;
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;
      const pin = def.pins.find((p) => p.id === assignment.pinId);
      if (!pin) continue;

      points.push({
        x: comp.schematicPos.x + PADDING_X + pin.offsetCol * PIN_SPACING,
        y: comp.schematicPos.y + PADDING_TOP + pin.offsetRow * PIN_SPACING,
        componentId: comp.id,
        pinId: pin.id,
      });
    }

    if (points.length < 2) continue;

    // Prim's MST
    const edges = primMST(points);
    result.push({ netId: net.id, color: net.color, edges });
  }

  return result;
}

function primMST(
  points: PinPoint[]
): { x1: number; y1: number; x2: number; y2: number }[] {
  const n = points.length;
  const inMST = new Array(n).fill(false);
  const minDist = new Array(n).fill(Infinity);
  const minEdge = new Array(n).fill(-1);
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];

  // Start from node 0
  minDist[0] = 0;

  for (let iter = 0; iter < n; iter++) {
    // Find the closest non-MST node
    let u = -1;
    for (let i = 0; i < n; i++) {
      if (!inMST[i] && (u === -1 || minDist[i] < minDist[u])) {
        u = i;
      }
    }

    inMST[u] = true;

    // Add edge to MST (skip the first node)
    if (minEdge[u] >= 0) {
      const from = points[minEdge[u]];
      const to = points[u];
      edges.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    }

    // Update distances
    for (let v = 0; v < n; v++) {
      if (inMST[v]) continue;
      const dx = points[u].x - points[v].x;
      const dy = points[u].y - points[v].y;
      const dist = dx * dx + dy * dy;
      if (dist < minDist[v]) {
        minDist[v] = dist;
        minEdge[v] = u;
      }
    }
  }

  return edges;
}
