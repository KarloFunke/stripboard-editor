import { useProjectStore } from "@/store/useProjectStore";
import { computeStripSegments, StripSegment } from "@/components/stripboard/stripSegments";
import { computeConnectivity, ConnectedGroup } from "@/components/stripboard/connectivity";
import { checkNetCompleteness, IncompleteNet } from "@/components/stripboard/netCompleteness";
import { boardView } from "@/components/stripboard/offBoard";
import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";

interface StripAnalysis {
  segments: StripSegment[];
  connectivity: ConnectedGroup[];
  conflictCount: number;
  incompleteNets: IncompleteNet[];
}

// The editor, the tray and the canvas all ask for this on every change, so
// the last analysis is shared between them: the inputs are immutable store
// values, like in boardView.
let last: { board: Board; components: Component[]; defs: ComponentDef[]; assignments: NetAssignment[]; nets: Net[]; out: StripAnalysis } | null = null;

function analyse(board: Board, components: Component[], defs: ComponentDef[], assignments: NetAssignment[], nets: Net[]): StripAnalysis {
  if (last && last.board === board && last.components === components && last.defs === defs && last.assignments === assignments && last.nets === nets) {
    return last.out;
  }
  const segments = computeStripSegments(board, components, defs, assignments);
  const connectivity = computeConnectivity(segments, board.wires);
  const out = {
    segments,
    connectivity,
    conflictCount: connectivity.filter((g) => g.hasConflict).length,
    incompleteNets: checkNetCompleteness(nets, assignments, segments, connectivity, components, defs),
  };
  last = { board, components, defs, assignments, nets, out };
  return out;
}

/** The board's copper as the board sees it: an off-board part is its solder pads. */
export function useStripSegments(): StripAnalysis {
  const board = useProjectStore((s) => s.board);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const stored = useProjectStore((s) => s.components);
  const storedAssignments = useProjectStore((s) => s.netAssignments);
  const { components, netAssignments } = boardView(stored, componentDefs, storedAssignments);
  return analyse(board, components, componentDefs, netAssignments, nets);
}
