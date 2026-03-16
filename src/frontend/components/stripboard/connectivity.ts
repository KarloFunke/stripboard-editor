import { Wire } from "@/types";
import { StripSegment } from "./stripSegments";

// ── Union-Find ─────────────────────────────────────────

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}

// ── Connectivity computation ───────────────────────────

export interface ConnectedGroup {
  segmentIndices: number[];
  wireIds: string[];
  netIds: string[];
  hasConflict: boolean;
}

/** Find which segment a hole belongs to, or -1 if none */
function findSegmentIndex(
  segments: StripSegment[],
  row: number,
  col: number
): number {
  return segments.findIndex(
    (s) => s.row === row && col >= s.startCol && col <= s.endCol
  );
}

/** Compute connected groups of strip segments bridged by wires */
export function computeConnectivity(
  segments: StripSegment[],
  wires: Wire[]
): ConnectedGroup[] {
  const n = segments.length;
  if (n === 0) return [];

  const uf = new UnionFind(n);
  const wireSegmentMap: { wireId: string; fromIdx: number; toIdx: number }[] = [];

  for (const wire of wires) {
    const fromIdx = findSegmentIndex(segments, wire.from.row, wire.from.col);
    const toIdx = findSegmentIndex(segments, wire.to.row, wire.to.col);
    if (fromIdx >= 0 && toIdx >= 0) {
      uf.union(fromIdx, toIdx);
      wireSegmentMap.push({ wireId: wire.id, fromIdx, toIdx });
    }
  }

  // Group segments by root
  const groups = new Map<number, ConnectedGroup>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) {
      groups.set(root, {
        segmentIndices: [],
        wireIds: [],
        netIds: [],
        hasConflict: false,
      });
    }
    groups.get(root)!.segmentIndices.push(i);
  }

  // Add wire IDs to groups
  for (const { wireId, fromIdx } of wireSegmentMap) {
    const root = uf.find(fromIdx);
    const group = groups.get(root)!;
    if (!group.wireIds.includes(wireId)) {
      group.wireIds.push(wireId);
    }
  }

  // Collect nets per group
  for (const group of groups.values()) {
    const netSet = new Set<string>();
    for (const idx of group.segmentIndices) {
      for (const netId of segments[idx].netIds) {
        netSet.add(netId);
      }
    }
    group.netIds = Array.from(netSet);
    group.hasConflict = group.netIds.length >= 2;
  }

  return Array.from(groups.values());
}

/** Get the connected group that a given segment belongs to */
export function getGroupForSegment(
  groups: ConnectedGroup[],
  segmentIndex: number
): ConnectedGroup | undefined {
  return groups.find((g) => g.segmentIndices.includes(segmentIndex));
}

/** Get the connected group for a wire */
export function getGroupForWire(
  groups: ConnectedGroup[],
  wireId: string
): ConnectedGroup | undefined {
  return groups.find((g) => g.wireIds.includes(wireId));
}
