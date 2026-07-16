// Stage-0 clustering for the v2 layouter, shared by the exploration CLIs.
//
// Graph: components are nodes; every net with pins on k distinct components
// adds weight 1/(k-1) to each pair it connects, so high-fanout (power-like)
// nets self-neutralize without any need to identify them by name.
// Clustering: deterministic size-capped average-linkage agglomeration —
// modularity methods collapse series-chain circuits into one blob, and the
// strip planner wants blocks of bounded size anyway.

/** Component graph over a project's board-included parts */
function buildComponentGraph(data) {
  const comps = data.components.filter((c) => !c.boardExcluded);
  const compById = new Map(comps.map((c) => [c.id, c]));
  const nodeIds = comps.map((c) => c.id);
  const nodeIdx = new Map(nodeIds.map((id, i) => [id, i]));

  const netComps = new Map(); // netId -> Set of component ids
  for (const a of data.netAssignments ?? []) {
    if (!compById.has(a.componentId)) continue;
    if (!netComps.has(a.netId)) netComps.set(a.netId, new Set());
    netComps.get(a.netId).add(a.componentId);
  }

  const n = nodeIds.length;
  const adj = Array.from({ length: n }, () => new Map());
  for (const [, members] of netComps) {
    const ids = [...members].map((id) => nodeIdx.get(id));
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
  return { comps, compById, nodeIds, nodeIdx, netComps, adj };
}

/**
 * Merge the pair of clusters with the highest average pairwise weight
 * (total inter-cluster weight / |A||B|) while the merged size stays within
 * the cap. Deterministic: ties go to the smaller merged size, then the
 * lowest cluster indices. Returns membership: node index -> cluster index.
 */
function agglomerate(adj, n, maxCluster) {
  const clusterMembers = Array.from({ length: n }, (_, i) => [i]);
  const clusterAlive = Array.from({ length: n }, () => true);
  const interW = new Map();
  const wKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  adj.forEach((m, i) => {
    for (const [j, w] of m) {
      if (i < j) interW.set(wKey(i, j), w);
    }
  });

  for (;;) {
    let best = null;
    for (const [key, w] of interW) {
      if (w <= 0) continue;
      const [a, b] = key.split(":").map(Number);
      if (!clusterAlive[a] || !clusterAlive[b]) continue;
      const sizeA = clusterMembers[a].length;
      const sizeB = clusterMembers[b].length;
      if (sizeA + sizeB > maxCluster) continue;
      const avg = w / (sizeA * sizeB);
      const better =
        !best ||
        avg > best.avg + 1e-12 ||
        (avg > best.avg - 1e-12 &&
          (sizeA + sizeB < best.size || (sizeA + sizeB === best.size && (a < best.a || (a === best.a && b < best.b)))));
      if (better) best = { a, b, avg, size: sizeA + sizeB };
    }
    if (!best) break;
    const { a, b } = best;
    clusterMembers[a].push(...clusterMembers[b]);
    clusterAlive[b] = false;
    for (const [key, w] of [...interW]) {
      const [x, y] = key.split(":").map(Number);
      if (x !== b && y !== b) continue;
      const other = x === b ? y : x;
      interW.delete(key);
      if (other === a) continue;
      const k2 = wKey(a, other);
      interW.set(k2, (interW.get(k2) ?? 0) + w);
    }
  }

  const membership = new Array(n);
  let clusterCount = 0;
  clusterMembers.forEach((members, ci) => {
    if (!clusterAlive[ci]) return;
    for (const i of members) membership[i] = clusterCount;
    clusterCount++;
  });
  return { membership, clusterCount };
}

module.exports = { buildComponentGraph, agglomerate };
