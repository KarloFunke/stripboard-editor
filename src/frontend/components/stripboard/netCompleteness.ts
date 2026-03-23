import {
  Net,
  NetAssignment,
  Component,
  ComponentDef,
  Wire,
} from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentPinPositions } from "./boardLayout";
import { StripSegment } from "./stripSegments";
import { ConnectedGroup } from "./connectivity";

export interface PinInfo {
  componentLabel: string;
  pinName: string;
}

export interface IncompleteNet {
  netId: string;
  netName: string;
  netColor: string;
  /** Groups of pins that are connected to each other but not to other groups */
  groups: PinInfo[][];
  /** Pins on components not yet placed on the board */
  unplacedPins: PinInfo[];
}

/** Find which segment a board position belongs to */
function findSegmentIndex(
  segments: StripSegment[],
  row: number,
  col: number
): number {
  return segments.findIndex(
    (s) => s.row === row && col >= s.startCol && col <= s.endCol
  );
}

/** Find which connected group a segment belongs to */
function findGroupIndex(
  connectivity: ConnectedGroup[],
  segmentIndex: number
): number {
  return connectivity.findIndex((g) =>
    g.segmentIndices.includes(segmentIndex)
  );
}

/** Check which nets are incomplete (pins not all connected) */
export function checkNetCompleteness(
  nets: Net[],
  netAssignments: NetAssignment[],
  segments: StripSegment[],
  connectivity: ConnectedGroup[],
  components: Component[],
  componentDefs: ComponentDef[]
): IncompleteNet[] {
  const result: IncompleteNet[] = [];

  for (const net of nets) {
    // Find all pins assigned to this net
    const assignments = netAssignments.filter((a) => a.netId === net.id);
    if (assignments.length <= 1) continue; // 0 or 1 pin can't be incomplete

    const unplacedPins: PinInfo[] = [];
    // Map: groupIndex → PinInfo[]
    const groupPins = new Map<number, PinInfo[]>();

    for (const assignment of assignments) {
      const comp = components.find((c) => c.id === assignment.componentId);
      if (!comp) continue;

      const def = resolveComponentDef(comp, componentDefs);
      if (!def) continue;

      const pin = def.pins.find((p) => p.id === assignment.pinId);
      if (!pin) continue;

      const pinInfo: PinInfo = {
        componentLabel: comp.label,
        pinName: pin.name,
      };

      if (!comp.boardPos) {
        unplacedPins.push(pinInfo);
        continue;
      }

      // Find board position of this pin
      const pinPositions = getComponentPinPositions(comp, def);
      const pinPos = pinPositions.find((p) => p.pinId === assignment.pinId);
      if (!pinPos) continue;

      // Find which segment and group
      const segIdx = findSegmentIndex(segments, pinPos.row, pinPos.col);
      if (segIdx < 0) continue;

      const grpIdx = findGroupIndex(connectivity, segIdx);
      if (grpIdx < 0) continue;

      if (!groupPins.has(grpIdx)) {
        groupPins.set(grpIdx, []);
      }
      groupPins.get(grpIdx)!.push(pinInfo);
    }

    const groups = Array.from(groupPins.values());
    const isIncomplete = groups.length > 1 || unplacedPins.length > 0;

    if (isIncomplete) {
      result.push({
        netId: net.id,
        netName: net.name,
        netColor: net.color,
        groups,
        unplacedPins,
      });
    }
  }

  return result;
}
