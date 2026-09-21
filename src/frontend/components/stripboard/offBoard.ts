// Off-board parts on the board.
//
// A part mounted off the board keeps its place in the schematic, and with it
// its nets, untouched. What the board gets is one solder pad per wired pin:
// a virtual one-hole connector drawn as a soldered wire, which the rest of the
// board code and the layout engines then treat like any other connector. The
// pads exist only in the expanded list built here; what is stored is the
// parent's `leads`, so nothing ever has to be kept in sync.

import { BoardPosition, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "../../utils/resolveComponentDef";
import { getRotatedPinPositions } from "./boardLayout";
import { footprintFor } from "./packageBodies";

export const LEAD_DEF_ID = "def-connector-1";
const LEAD_PIN_ID = "1";
const SEP = "#";

export function leadId(componentId: string, pinId: string): string {
  return `${componentId}${SEP}${pinId}`;
}

/** The off-board part and pin a pad stands for, or null for a real component. */
export function parseLeadId(id: string): { componentId: string; pinId: string } | null {
  const at = id.lastIndexOf(SEP);
  return at <= 0 ? null : { componentId: id.slice(0, at), pinId: id.slice(at + 1) };
}

/** A pad's component as the board sees it. `leadOf` marks it as virtual. */
export type LeadComponent = Component & { leadOf: { componentId: string; pinId: string } };

export function isLead(c: Component): c is LeadComponent {
  return (c as LeadComponent).leadOf !== undefined;
}

/** What an off-board part's wires may arrive at, loose pads first. */
export const OFF_BOARD_CONNECTIONS: { id: string; name: string }[] = [
  { id: "wire", name: "Soldered wires, loose pads" },
  { id: "wire-row", name: "Soldered wires, in a row" },
  { id: "header", name: "Pin header" },
  { id: "jst-xh", name: "JST XH socket" },
  { id: "term-508", name: "Screw terminal, 5.08 mm" },
];

/** Pin id of the one virtual part that stands for a whole grouped connector. */
export const GROUP_PIN = "*";

/** The part's wired pins, once each, in the order its definition lists them. */
function wiredPins(c: Component, def: ComponentDef | undefined, netAssignments: NetAssignment[]) {
  const out: { pinId: string; name: string; netId: string }[] = [];
  const seen = new Set<string>();
  const mine = netAssignments.filter((a) => a.componentId === c.id);
  const order = [...(def?.pins.map((p) => p.id) ?? []), ...mine.map((a) => a.pinId)];
  for (const pinId of order) {
    if (seen.has(pinId)) continue;
    seen.add(pinId);
    const a = mine.find((x) => x.pinId === pinId);
    if (a) out.push({ pinId, name: def?.pins.find((p) => p.id === pinId)?.name ?? pinId, netId: a.netId });
  }
  return out;
}

/**
 * The components and net assignments as the board sees them: every off-board
 * part replaced by what its wires arrive at. By default that is one loose pad
 * per distinct pin that carries a net (a pin left unwired needs no wire, and
 * legs that share a pin id share one pad). With a connector chosen it is one
 * connector of that many pins instead, carrying the part's own pin names.
 */
export function expandOffBoard(
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
): { components: Component[]; netAssignments: NetAssignment[] } {
  if (!components.some((c) => c.offBoard && !c.boardExcluded)) return { components, netAssignments };

  const outComponents: Component[] = [];
  const outAssignments: NetAssignment[] = [];
  const offBoardIds = new Set<string>();

  for (const c of components) {
    if (!c.offBoard || c.boardExcluded) {
      outComponents.push(c);
      continue;
    }
    offBoardIds.add(c.id);
    const def = componentDefs.find((d) => d.id === c.defId);
    const pins = wiredPins(c, def, netAssignments);
    const connDef = c.offBoardPackage ? componentDefs.find((d) => d.id === `def-connector-${pins.length}`) : undefined;

    if (connDef) {
      const pkg = c.offBoardPackage === "wire-row" ? "wire" : c.offBoardPackage!;
      const shape = footprintFor(connDef, pkg) ?? { width: connDef.width, height: connDef.height, pins: connDef.pins, bodyCells: connDef.bodyCells };
      const id = leadId(c.id, GROUP_PIN);
      const group: LeadComponent = {
        id,
        defId: connDef.id,
        label: c.label,
        schematicPos: c.schematicPos,
        schematicRotation: 0,
        boardPos: c.boardPos,
        rotation: c.rotation,
        boardLabelOffset: c.boardLabelOffset,
        package: pkg,
        locked: c.locked,
        // the connector's own shape, with the part's pin names on it
        footprintOverride: { ...shape, pins: shape.pins.map((p, i) => ({ ...p, name: pins[i]?.name ?? p.name })) },
        leadOf: { componentId: c.id, pinId: GROUP_PIN },
      };
      outComponents.push(group);
      pins.forEach((pin, i) => outAssignments.push({ netId: pin.netId, componentId: id, pinId: connDef.pins[i].id }));
      continue;
    }

    for (const pin of pins) {
      const id = leadId(c.id, pin.pinId);
      const lead: LeadComponent = {
        id,
        defId: LEAD_DEF_ID,
        label: `${c.label} ${pin.name}`,
        schematicPos: c.schematicPos,
        schematicRotation: 0,
        boardPos: c.leads?.[pin.pinId] ?? null,
        rotation: 0,
        boardLabelOffset: c.leadLabelOffsets?.[pin.pinId],
        package: "wire",
        locked: c.locked,
        leadOf: { componentId: c.id, pinId: pin.pinId },
      };
      outComponents.push(lead);
      outAssignments.push({ netId: pin.netId, componentId: id, pinId: LEAD_PIN_ID });
    }
  }
  for (const a of netAssignments) if (!offBoardIds.has(a.componentId)) outAssignments.push(a);
  return { components: outComponents, netAssignments: outAssignments };
}

/**
 * Pad positions folded back onto their off-board parents. `positions` maps a
 * component id, real or pad, to where it now sits (null = taken off the
 * board); ids that are not pads are ignored.
 */
export function collapseLeads(
  components: Component[],
  positions: Map<string, BoardPosition | null>,
): Component[] {
  const byParent = new Map<string, Map<string, BoardPosition | null>>();
  for (const [id, pos] of positions) {
    const lead = parseLeadId(id);
    if (!lead) continue;
    if (!byParent.has(lead.componentId)) byParent.set(lead.componentId, new Map());
    byParent.get(lead.componentId)!.set(lead.pinId, pos);
  }
  if (byParent.size === 0) return components;
  return components.map((c) => {
    const moved = byParent.get(c.id);
    if (!moved) return c;
    const leads = { ...(c.leads ?? {}) };
    for (const [pinId, pos] of moved) {
      if (pos) leads[pinId] = pos;
      else delete leads[pinId];
    }
    return { ...c, leads: Object.keys(leads).length > 0 ? leads : undefined };
  });
}

/** Pads that belong to the same off-board part, for keeping them together. */
export function leadSiblings(components: Component[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const c of components) {
    if (!isLead(c)) continue;
    const key = c.leadOf.componentId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c.id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// The board's view is asked for by every placed part on every render, so the
// last expansion is kept: the three inputs are immutable store values.
let lastView: { c: Component[]; d: ComponentDef[]; a: NetAssignment[]; out: ReturnType<typeof expandOffBoard> } | null = null;

export function boardView(
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
): { components: Component[]; netAssignments: NetAssignment[] } {
  if (lastView && lastView.c === components && lastView.d === componentDefs && lastView.a === netAssignments) return lastView.out;
  const out = expandOffBoard(components, componentDefs, netAssignments);
  lastView = { c: components, d: componentDefs, a: netAssignments, out };
  return out;
}

/**
 * Run a board-side edit over the components as the board sees them, pads
 * included, and fold what it did to the pads back onto their off-board
 * parents. Lets every board action stay a plain map over components.
 * A lock belongs to the part: locking one pad locks its siblings too.
 */
export function editBoardView(
  components: Component[],
  componentDefs: ComponentDef[],
  netAssignments: NetAssignment[],
  edit: (view: Component[]) => Component[],
): Component[] {
  const view = boardView(components, componentDefs, netAssignments).components;
  if (view === components) return edit(components);

  const next = edit(view);
  const realById = new Map<string, Component>();
  const padsOf = new Map<string, LeadComponent[]>();
  for (const c of next) {
    if (!isLead(c)) {
      realById.set(c.id, c);
      continue;
    }
    if (!padsOf.has(c.leadOf.componentId)) padsOf.set(c.leadOf.componentId, []);
    padsOf.get(c.leadOf.componentId)!.push(c);
  }
  return components.map((c) => {
    if (!c.offBoard || c.boardExcluded) return realById.get(c.id) ?? c;
    const pads = padsOf.get(c.id) ?? [];
    const flipped = pads.find((pad) => !!pad.locked !== !!c.locked);
    const locked = flipped ? flipped.locked || undefined : c.locked;
    const group = pads.find((pad) => pad.leadOf.pinId === GROUP_PIN);
    if (group) {
      const same = locked === c.locked && group.rotation === c.rotation &&
        group.boardPos?.row === c.boardPos?.row && group.boardPos?.col === c.boardPos?.col;
      return same ? c : { ...c, locked, boardPos: group.boardPos, rotation: group.rotation };
    }
    const leads = { ...(c.leads ?? {}) };
    for (const pad of pads) {
      if (pad.boardPos) leads[pad.leadOf.pinId] = pad.boardPos;
      else delete leads[pad.leadOf.pinId];
    }
    const same = locked === c.locked && JSON.stringify(leads) === JSON.stringify(c.leads ?? {});
    return same ? c : { ...c, locked, leads: Object.keys(leads).length > 0 ? leads : undefined };
  });
}

export interface OffBoardWiring {
  label: string;
  name: string;
  value?: string;
  wires: { pin: string; net: string; pad: BoardPosition | null }[];
}

/**
 * What the builder has to wire by hand: for every off-board part, which pin
 * goes to which solder pad. Pins in the definition's order, unwired ones left
 * out, legs sharing a pin id listed once.
 */
export function offBoardWiring(
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
): OffBoardWiring[] {
  const view = expandOffBoard(components, componentDefs, netAssignments).components.filter(isLead);
  const out: OffBoardWiring[] = [];
  for (const c of components) {
    if (!c.offBoard || c.boardExcluded) continue;
    const def = componentDefs.find((d) => d.id === c.defId);
    const mine = view.filter((v) => v.leadOf.componentId === c.id);
    const group = mine.find((v) => v.leadOf.pinId === GROUP_PIN);
    const groupDef = group && resolveComponentDef(group, componentDefs);
    const groupPins = group?.boardPos && groupDef ? getRotatedPinPositions(groupDef, group.boardPos, group.rotation) : [];
    const wires = wiredPins(c, def, netAssignments).map((pin, i) => ({
      pin: pin.name,
      net: nets.find((n) => n.id === pin.netId)?.name ?? "",
      pad: group
        ? (groupPins[i] ? { row: groupPins[i].row, col: groupPins[i].col } : null)
        : mine.find((v) => v.leadOf.pinId === pin.pinId)?.boardPos ?? null,
    }));
    out.push({ label: c.label, name: def?.name ?? "", value: c.value, wires });
  }
  return out;
}
