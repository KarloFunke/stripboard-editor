import { Component, NetAssignment } from "@/types";

// Cluster size cap, from the 2026-07 cap study (caps 5-25 x full corpus,
// with the V1 tile polish active): small tiles win nearly everywhere once
// the polish can fuse them — big boards most of all (26-60 parts: 1.03x
// human at cap 5 vs 1.36x at cap 12). Mid-size projects keep a slightly
// roomier cap. Callers may override via AutoLayout2Options.maxCluster.
export function clusterCapFor(parts: number): number {
  return parts <= 10 ? 6 : 5;
}

// ── Stage 0: clustering ────────────────────────────────

export interface ComponentGraph {
  nodes: Component[];
  adj: Map<number, number>[]; // index -> (index -> weight)
}

export function buildComponentGraph(components: Component[], netAssignments: NetAssignment[]): ComponentGraph {
  const nodes = components.filter((c) => !c.boardExcluded);
  const idx = new Map(nodes.map((c, i) => [c.id, i]));
  const netMembers = new Map<string, Set<number>>();
  for (const a of netAssignments) {
    const i = idx.get(a.componentId);
    if (i === undefined) continue;
    if (!netMembers.has(a.netId)) netMembers.set(a.netId, new Set());
    netMembers.get(a.netId)!.add(i);
  }
  const adj: Map<number, number>[] = nodes.map(() => new Map());
  for (const [, members] of netMembers) {
    const ids = [...members];
    const k = ids.length;
    if (k < 2) continue;
    const w = 1 / (k - 1);
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        adj[ids[i]].set(ids[j], (adj[ids[i]].get(ids[j]) ?? 0) + w);
        adj[ids[j]].set(ids[i], (adj[ids[j]].get(ids[i]) ?? 0) + w);
      }
    }
  }
  return { nodes, adj };
}

/** Deterministic size-capped average-linkage agglomeration */
export function agglomerate(adj: Map<number, number>[], n: number, maxCluster: number): number[] {
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const alive: boolean[] = Array.from({ length: n }, () => true);
  const interW = new Map<string, number>();
  const wKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  adj.forEach((m, i) => {
    for (const [j, w] of m) {
      if (i < j) interW.set(wKey(i, j), w);
    }
  });

  for (;;) {
    let best: { a: number; b: number; avg: number; size: number } | null = null;
    for (const [key, w] of interW) {
      if (w <= 0) continue;
      const [a, b] = key.split(":").map(Number);
      if (!alive[a] || !alive[b]) continue;
      const size = members[a].length + members[b].length;
      if (size > maxCluster) continue;
      const avg = w / (members[a].length * members[b].length);
      const better =
        !best ||
        avg > best.avg + 1e-12 ||
        (avg > best.avg - 1e-12 &&
          (size < best.size || (size === best.size && (a < best.a || (a === best.a && b < best.b)))));
      if (better) best = { a, b, avg, size };
    }
    if (!best) break;
    const { a, b } = best;
    members[a].push(...members[b]);
    alive[b] = false;
    for (const [key, w] of [...interW]) {
      const [x, yv] = key.split(":").map(Number);
      if (x !== b && yv !== b) continue;
      const other = x === b ? yv : x;
      interW.delete(key);
      if (other === a) continue;
      const k2 = wKey(a, other);
      interW.set(k2, (interW.get(k2) ?? 0) + w);
    }
  }

  const membership = new Array<number>(n);
  let count = 0;
  members.forEach((list, ci) => {
    if (!alive[ci]) return;
    for (const i of list) membership[i] = count;
    count++;
  });
  return membership;
}

