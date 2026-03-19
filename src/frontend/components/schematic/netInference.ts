import { SchematicWire, Net, NetAssignment, Component, ComponentDef } from "@/types";
import { getWirePoints } from "./SchematicWireLine";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getRotatedPinPositions } from "./SymbolRenderer";
import { pointKey } from "@/utils/schematicConstants";
import { randomNetColor, nextNetName } from "@/utils/netColors";

// ── Union-Find ────────────────────────────────────────

class UnionFind {
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

const PERSISTENT_NET_NAMES = new Set(["VCC", "GND"]);

/**
 * Recalculate nets from wire segments using spatial matching.
 *
 * 1. Union-Find groups all grid points connected by wire segments
 * 2. For each component pin, compute its absolute grid position
 * 3. If a pin's position matches a connected grid point, the pin joins that net group
 * 4. Each group with at least one pin = one net
 */
export function recalculateNets(
  wires: SchematicWire[],
  existingNets: Net[],
  existingAssignments: NetAssignment[],
  components: Component[],
  componentDefs?: ComponentDef[],
): { nets: Net[]; netAssignments: NetAssignment[] } {
  const uf = new UnionFind();

  // Step 1: Union all points along each wire (start, bend, end)
  for (const wire of wires) {
    const pts = getWirePoints(wire);
    const keys = pts.map((p) => pointKey(p.x, p.y));
    for (const k of keys) uf.makeSet(k);
    for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);
  }

  // Step 2: Find all component pin positions
  const pinPositions: { componentId: string; pinId: string; key: string }[] = [];

  if (componentDefs) {
    for (const comp of components) {
      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;

      const rotation = comp.schematicRotation ?? 0;
      const rotatedPins = getRotatedPinPositions(def.symbol, rotation);

      for (const pin of rotatedPins) {
        const absX = comp.schematicPos.x + pin.x;
        const absY = comp.schematicPos.y + pin.y;
        const key = pointKey(absX, absY);
        pinPositions.push({ componentId: comp.id, pinId: pin.pinId, key });

        // If this point is on a wire, it's already in UF.
        // If not, make a set for it (isolated pin).
        uf.makeSet(key);
      }
    }
  }

  // Step 3: Group pins by their connected component root
  const groups = new Map<string, { componentId: string; pinId: string }[]>();
  for (const pp of pinPositions) {
    const root = uf.find(pp.key);
    // Only include if this point is connected to at least one wire
    const isOnWire = wires.some((w) => {
      const pts = getWirePoints(w);
      return pts.some((p) => uf.find(pointKey(p.x, p.y)) === root);
    });
    if (!isOnWire) continue;

    if (!groups.has(root)) groups.set(root, []);
    const group = groups.get(root)!;
    if (!group.some((p) => p.componentId === pp.componentId && p.pinId === pp.pinId)) {
      group.push({ componentId: pp.componentId, pinId: pp.pinId });
    }
  }

  // Step 4: Match groups to existing nets and create assignments
  const pinToExistingNet = new Map<string, string>();
  for (const a of existingAssignments) {
    pinToExistingNet.set(`${a.componentId}:${a.pinId}`, a.netId);
  }

  const newNets: Net[] = [];
  const newAssignments: NetAssignment[] = [];
  const usedNetIds = new Set<string>();

  for (const [, pins] of groups) {
    if (pins.length === 0) continue;

    // Find which existing nets these pins belong to
    const netCounts = new Map<string, number>();
    for (const pin of pins) {
      const netId = pinToExistingNet.get(`${pin.componentId}:${pin.pinId}`);
      if (netId) {
        netCounts.set(netId, (netCounts.get(netId) ?? 0) + 1);
      }
    }

    let assignedNet: Net | undefined;

    if (netCounts.size > 0) {
      let bestNetId = "";
      let bestCount = 0;
      for (const [netId, count] of netCounts) {
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
      assignedNet = {
        id: generateId(),
        name: nextNetName([...existingNets, ...newNets]),
        color: randomNetColor([...existingNets, ...newNets]),
      };
    }

    if (!usedNetIds.has(assignedNet.id)) {
      newNets.push(assignedNet);
      usedNetIds.add(assignedNet.id);
    }

    for (const pin of pins) {
      newAssignments.push({
        netId: assignedNet.id,
        componentId: pin.componentId,
        pinId: pin.pinId,
      });
    }
  }

  // Keep persistent nets (VCC, GND) even if unused
  for (const net of existingNets) {
    if (PERSISTENT_NET_NAMES.has(net.name) && !usedNetIds.has(net.id)) {
      newNets.push(net);
    }
  }

  return { nets: newNets, netAssignments: newAssignments };
}
