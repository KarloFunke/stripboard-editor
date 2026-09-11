import { SchematicWire, Net, NetAssignment, Component, ComponentDef, NetLabel } from "@/types";
import { pointKey } from "@/utils/schematicConstants";
import { randomNetColor, nextNetName } from "@/utils/netColors";
import { schematicPinPoints } from "./schematicGeometry";

// ── Union-Find ────────────────────────────────────────

export class UnionFind {
  parent: Map<string, string>;
  rank: Map<string, number>;

  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }

  makeSet(x: string) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    if (!this.parent.has(x)) this.makeSet(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

function generateId(): string {
  return crypto.randomUUID();
}

/** Everything a change to the wiring rules would do to the nets */
export interface NetDiff {
  /** Separate nets that become one */
  merges: { into: string; joined: string[] }[];
  /** Pins that had no net and join an existing one */
  joins: { net: string; pins: string[] }[];
  /** Nets formed out of pins that had none */
  newNets: { pins: string[] }[];
  /** Nets that keep their pins but take a name from a flag they now touch */
  renames: { from: string; to: string }[];
}

/**
 * Compare two net states, in the terms a user cares about. Connections are
 * only ever added between the two (the touch rules are a superset of the
 * classic ones), so every difference falls into one of the four kinds.
 * `pinLabel` renders a pin for display, e.g. "C1 pin 2".
 */
export function diffNets(
  before: { nets: Net[]; netAssignments: NetAssignment[] },
  after: { nets: Net[]; netAssignments: NetAssignment[] },
  pinLabel: (componentId: string, pinId: string) => string,
): NetDiff {
  const key = (a: NetAssignment) => `${a.componentId}:${a.pinId}`;
  const beforeNetOfPin = new Map(before.netAssignments.map((a) => [key(a), a.netId]));
  const beforeById = new Map(before.nets.map((n) => [n.id, n]));
  const afterById = new Map(after.nets.map((n) => [n.id, n]));

  const pinsByAfterNet = new Map<string, NetAssignment[]>();
  for (const a of after.netAssignments) {
    const arr = pinsByAfterNet.get(a.netId);
    if (arr) arr.push(a);
    else pinsByAfterNet.set(a.netId, [a]);
  }

  const diff: NetDiff = { merges: [], joins: [], newNets: [], renames: [] };
  for (const [netId, pins] of pinsByAfterNet) {
    const net = afterById.get(netId);
    if (!net) continue;
    const from = new Set<string>();
    const fresh: NetAssignment[] = [];
    for (const a of pins) {
      const b = beforeNetOfPin.get(key(a));
      if (b) from.add(b);
      else fresh.push(a);
    }
    if (from.size === 0) {
      if (pins.length >= 2) diff.newNets.push({ pins: pins.map((a) => pinLabel(a.componentId, a.pinId)) });
      continue;
    }
    if (from.size > 1) {
      const joined = [...from].filter((id) => id !== netId).map((id) => beforeById.get(id)?.name).filter((n): n is string => !!n);
      if (joined.length > 0) diff.merges.push({ into: net.name, joined });
    }
    if (fresh.length > 0) {
      diff.joins.push({ net: net.name, pins: fresh.map((a) => pinLabel(a.componentId, a.pinId)) });
    }
  }
  for (const net of after.nets) {
    const b = beforeById.get(net.id);
    if (b && b.name !== net.name) diff.renames.push({ from: b.name, to: net.name });
  }
  return diff;
}

export function netDiffIsEmpty(d: NetDiff): boolean {
  return d.merges.length === 0 && d.joins.length === 0 && d.newNets.length === 0 && d.renames.length === 0;
}

/**
 * Recalculate nets from wire endpoints, pins and labels.
 *
 * 1. Union-Find joins the two endpoints of every wire (bends and segment
 *    bodies never connect; normalizeWires() turns any real contact into an
 *    endpoint first)
 * 2. Every label is a connection point, and all labels sharing a name are
 *    joined
 * 3. A pin joins the group at its exact grid point; a group counts as a net
 *    when it holds a wire end or a label, or two pins on the same point
 * 4. A group carrying a label is named after it; other groups keep the net
 *    most of their pins already belonged to. Existing nets keep their order.
 */
export function recalculateNets(
  wires: SchematicWire[],
  existingNets: Net[],
  existingAssignments: NetAssignment[],
  components: Component[],
  componentDefs?: ComponentDef[],
  netLabels: NetLabel[] = [],
): { nets: Net[]; netAssignments: NetAssignment[] } {
  const uf = new UnionFind();
  const anchored = new Set<string>();

  for (const wire of wires) {
    const a = pointKey(wire.start.x, wire.start.y);
    const b = pointKey(wire.end.x, wire.end.y);
    uf.makeSet(a);
    uf.makeSet(b);
    uf.union(a, b);
    anchored.add(a);
    anchored.add(b);
  }

  const byName = new Map<string, string[]>();
  const kindByName = new Map<string, NetLabel["kind"]>();
  for (const l of netLabels) {
    const k = pointKey(l.pos.x, l.pos.y);
    uf.makeSet(k);
    anchored.add(k);
    const name = l.name.trim();
    if (!name) continue;
    const arr = byName.get(name);
    if (arr) arr.push(k);
    else byName.set(name, [k]);
    if (!kindByName.has(name)) kindByName.set(name, l.kind);
  }
  for (const keys of byName.values()) {
    for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);
  }

  const pinPositions = componentDefs ? schematicPinPoints(components, componentDefs) : [];
  for (const pp of pinPositions) uf.makeSet(pp.key);

  const anchoredRoots = new Set<string>();
  for (const k of anchored) anchoredRoots.add(uf.find(k));

  const flagNameByRoot = new Map<string, string>();
  for (const [name, keys] of byName) {
    const root = uf.find(keys[0]);
    const cur = flagNameByRoot.get(root);
    if (cur === undefined || name < cur) flagNameByRoot.set(root, name);
  }

  // Group pins by connected root. A group is a net when something anchors
  // it (a wire end or a label) or when two pins sit on the same point.
  const groups = new Map<string, { componentId: string; pinId: string }[]>();
  for (const pp of pinPositions) {
    const root = uf.find(pp.key);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    if (!group.some((p) => p.componentId === pp.componentId && p.pinId === pp.pinId)) {
      group.push({ componentId: pp.componentId, pinId: pp.pinId });
    }
  }

  for (const [root, pins] of groups) {
    if (!anchoredRoots.has(root) && pins.length < 2) groups.delete(root);
  }

  const pinToExistingNet = new Map<string, string>();
  for (const a of existingAssignments) {
    pinToExistingNet.set(`${a.componentId}:${a.pinId}`, a.netId);
  }

  const newNets: Net[] = [];
  const newAssignments: NetAssignment[] = [];
  const usedNetIds = new Set<string>();

  // Labelled groups claim their nets first so a name is never taken by a
  // group that merely used to hold some of its pins.
  const ordered = [...groups.entries()].sort(([ra], [rb]) => {
    const fa = flagNameByRoot.has(ra) ? 0 : 1;
    const fb = flagNameByRoot.has(rb) ? 0 : 1;
    return fa - fb;
  });

  for (const [root, pins] of ordered) {
    if (pins.length === 0) continue;
    const flagName = flagNameByRoot.get(root);

    let assignedNet: Net | undefined;

    if (flagName !== undefined) {
      assignedNet = existingNets.find((n) => n.name === flagName && !usedNetIds.has(n.id));
    }

    if (!assignedNet) {
      const netCounts = new Map<string, number>();
      for (const pin of pins) {
        const netId = pinToExistingNet.get(`${pin.componentId}:${pin.pinId}`);
        if (netId) netCounts.set(netId, (netCounts.get(netId) ?? 0) + 1);
      }
      let bestNetId = "";
      let bestCount = 0;
      for (const [netId, count] of netCounts) {
        // Skip nets already claimed by another group (handles net splitting)
        if (usedNetIds.has(netId)) continue;
        const net = existingNets.find((n) => n.id === netId);
        if (!net) continue;
        const isUserNamed = !net.name.match(/^net\d+$/);
        if (count > bestCount || (count === bestCount && isUserNamed)) {
          bestNetId = netId;
          bestCount = count;
        }
      }
      assignedNet = existingNets.find((n) => n.id === bestNetId);
    }

    if (!assignedNet) {
      // Ground and power nets get the conventional colours; the rest draw
      // from the palette.
      const kind = flagName !== undefined ? kindByName.get(flagName) : undefined;
      assignedNet = {
        id: generateId(),
        name: flagName ?? nextNetName([...existingNets, ...newNets]),
        color: kind === "gnd" ? "#000000" : kind === "power" ? "#dc2626" : randomNetColor([...existingNets, ...newNets]),
      };
    } else if (flagName !== undefined && assignedNet.name !== flagName) {
      assignedNet = { ...assignedNet, name: flagName };
    }

    newNets.push(assignedNet);
    usedNetIds.add(assignedNet.id);

    for (const pin of pins) {
      newAssignments.push({ netId: assignedNet.id, componentId: pin.componentId, pinId: pin.pinId });
    }
  }

  // Keep the sidebar stable: nets that already existed stay in their order,
  // new ones append.
  const order = new Map(existingNets.map((n, i) => [n.id, i]));
  newNets.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  return { nets: newNets, netAssignments: newAssignments };
}
