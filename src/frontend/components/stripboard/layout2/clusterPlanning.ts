import { Component, ComponentDef, NetAssignment } from "@/types";
import { DimLimits, MAX_TILE_RIGIDS, Tile } from "./tileModel";
import { analyzeCluster } from "./tilePlanning";
import { planTile } from "./tilePlanning";

// ── Stage 1: turn clusters into tiles, with fallbacks ──
// Plans each cluster as one tile where possible; oversized or unplannable
// clusters are split along their weakest net links (or per rigid group)
// and re-planned recursively. Results accumulate into the caller's
// tiles/unplaced/issues arrays; the returned function is also what the
// orchestrator's demotion path calls to re-plan a demoted tile's parts.
export function makeClusterPlanner(
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  lockedIds: Set<string>,
  limits: DimLimits,
  planLimits: DimLimits,
  tiles: Tile[],
  unplaced: Component[],
  issues: string[]
): (cluster: Component[]) => void {
  // Chain the components by shared nets (seeded at `seed` if given) and cut
  // at the weakest link near the middle. Lets an oversized flex-heavy block
  // shed half its parts into a second tile that stacks below.
  const splitByNets = (cluster: Component[], clusterAsg: NetAssignment[], seed?: Component): [Component[], Component[]] | null => {
    if (cluster.length < 2) return null;
    const netsOf = new Map<string, Set<string>>();
    for (const a of clusterAsg) {
      if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
      netsOf.get(a.componentId)!.add(a.netId);
    }
    const shared = (a: Component, b: Component) => {
      let n = 0;
      for (const x of netsOf.get(a.id) ?? []) if (netsOf.get(b.id)?.has(x)) n++;
      return n;
    };
    const chain: Component[] = [seed ?? cluster.reduce((a, b) => {
      const sa = cluster.reduce((s, o) => s + (o === a ? 0 : shared(a, o)), 0);
      const sb = cluster.reduce((s, o) => s + (o === b ? 0 : shared(b, o)), 0);
      return sb > sa ? b : a;
    })];
    const rest = cluster.filter((c) => c !== chain[0]);
    while (rest.length > 0) {
      let best = 0;
      let bestW = -1;
      rest.forEach((c, i) => {
        const w = Math.max(...chain.map((o) => shared(o, c)));
        if (w > bestW) {
          bestW = w;
          best = i;
        }
      });
      chain.push(rest[best]);
      rest.splice(best, 1);
    }
    let cut = 1;
    let cutScore = Infinity;
    for (let i = 1; i < chain.length; i++) {
      const s = 10 * shared(chain[i - 1], chain[i]) + Math.abs(i - chain.length / 2);
      if (s < cutScore) {
        cutScore = s;
        cut = i;
      }
    }
    return [chain.slice(0, cut), chain.slice(cut)];
  };

  const planWithFallbacks = (cluster: Component[]) => {
    const ids = new Set(cluster.map((c) => c.id));
    const clusterAsg = netAssignments.filter((a) => ids.has(a.componentId));
    const analysis = analyzeCluster(cluster, clusterAsg, componentDefs);
    const k = analysis.rigids.length;
    if (k <= MAX_TILE_RIGIDS) {
      // blocks around locked members plan against the real caps — their
      // frozen span is what it is, no wire-channel reservation applies
      const tile = planTile(analysis, analysis.rigids.some((r) => r.fixed) ? limits : planLimits);
      // an anchored tile is judged by its absolute extent against the real caps
      const tooBig = tile !== null && (tile.anchor
        ? ((limits.maxCols !== undefined && tile.anchor.col + tile.width > limits.maxCols) ||
          (limits.maxRows !== undefined && tile.anchor.row + tile.height > limits.maxRows))
        : ((planLimits.maxCols !== undefined && tile.width > planLimits.maxCols) ||
          (planLimits.maxRows !== undefined && tile.height > planLimits.maxRows)));
      if (tile && !tooBig) {
        tiles.push(tile);
        unplaced.push(...tile.unplaced);
        return;
      }
      if (k <= 1) {
        if (tooBig && cluster.length >= 2) {
          // shed parts into a second tile until the block can fit
          const subs = splitByNets(cluster, clusterAsg, analysis.rigids[0]?.comp);
          if (subs && subs[0].length > 0 && subs[1].length > 0) {
            planWithFallbacks(subs[0]);
            planWithFallbacks(subs[1]);
            return;
          }
        }
        if (tile) {
          // a lone part's tile is as small as it gets — keep it and let
          // the floorplan report any overflow
          tiles.push(tile);
          unplaced.push(...tile.unplaced);
          return;
        }
        if (cluster.some((c) => lockedIds.has(c.id))) {
          // locked members stay put as plain obstacles; plan the rest
          const rest = cluster.filter((c) => !lockedIds.has(c.id));
          if (rest.length > 0) planWithFallbacks(rest);
          return;
        }
        issues.push(`block with ${cluster.map((c) => c.label).join(", ")}: no strip plan found`);
        unplaced.push(...cluster);
        return;
      }
      if (tooBig) {
        // the tile exceeds a locked dimension: split the rigid chain at its
        // weakest link and plan the halves — smaller tiles wrap into bands
        const netsOf = new Map<string, Set<string>>();
        for (const a of clusterAsg) {
          if (!netsOf.has(a.componentId)) netsOf.set(a.componentId, new Set());
          netsOf.get(a.componentId)!.add(a.netId);
        }
        const sharedPair = (x: number, z: number) => {
          let n = 0;
          for (const nid of netsOf.get(analysis.rigids[x].comp.id) ?? []) {
            if (netsOf.get(analysis.rigids[z].comp.id)?.has(nid)) n++;
          }
          return n;
        };
        let cut = 1;
        let cutScore = Infinity;
        for (let i = 1; i < k; i++) {
          const s = 10 * sharedPair(i - 1, i) + Math.abs(i - k / 2);
          if (s < cutScore) {
            cutScore = s;
            cut = i;
          }
        }
        const subs: Component[][] = [[], []];
        for (const comp of cluster) {
          subs[(analysis.groupOf.get(comp.id) ?? 0) < cut ? 0 : 1].push(comp);
        }
        if (subs[0].length > 0 && subs[1].length > 0) {
          planWithFallbacks(subs[0]);
          planWithFallbacks(subs[1]);
          return;
        }
      }
      // joint plan failed: retry one group per rigid
      const groups = new Map<number, Component[]>();
      for (const comp of cluster) {
        const gi = analysis.groupOf.get(comp.id) ?? 0;
        if (!groups.has(gi)) groups.set(gi, []);
        groups.get(gi)!.push(comp);
      }
      for (const sub of groups.values()) {
        if (sub.length === cluster.length) {
          if (sub.some((c) => lockedIds.has(c.id))) {
            const rest = sub.filter((c) => !lockedIds.has(c.id));
            if (rest.length > 0) planWithFallbacks(rest);
            return;
          }
          issues.push(`block with ${sub.map((c) => c.label).join(", ")}: no strip plan found`);
          unplaced.push(...sub);
          return;
        }
        planWithFallbacks(sub);
      }
      return;
    }
    // Too many rigids for one tile: cut the affinity chain at its weakest
    // links into runs that fit, so strongly connected rigids still share
    // strips and only the weakest nets become inter-tile wires.
    const netsOfRigid = analysis.rigids.map((r) =>
      new Set(clusterAsg.filter((a) => a.componentId === r.comp.id).map((a) => a.netId)));
    const sharedR = (a: number, b: number) => {
      let n = 0;
      for (const x of netsOfRigid[a]) if (netsOfRigid[b].has(x)) n++;
      return n;
    };
    const chunks: number[][] = [Array.from({ length: k }, (_, i) => i)];
    while (chunks.some((ch) => ch.length > MAX_TILE_RIGIDS)) {
      const idx = chunks.findIndex((ch) => ch.length > MAX_TILE_RIGIDS);
      const ch = chunks[idx];
      let best = 1;
      let bestScore = Infinity;
      for (let i = 1; i < ch.length; i++) {
        const oversize = Math.max(i, ch.length - i) > MAX_TILE_RIGIDS ? 1000 : 0;
        const score = oversize + 10 * sharedR(ch[i - 1], ch[i]) + Math.abs(i - ch.length / 2);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      chunks.splice(idx, 1, ch.slice(0, best), ch.slice(best));
    }
    const chunkOfRigid = new Map<number, number>();
    chunks.forEach((ch, ci) => ch.forEach((ri) => chunkOfRigid.set(ri, ci)));
    const subs: Component[][] = chunks.map(() => []);
    for (const comp of cluster) {
      const gi = analysis.groupOf.get(comp.id) ?? 0;
      subs[chunkOfRigid.get(gi) ?? 0].push(comp);
    }
    for (const sub of subs) {
      if (sub.length > 0) planWithFallbacks(sub);
    }
  };
  return planWithFallbacks;
}
