import { useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { computeStripSegments } from "@/components/stripboard/stripSegments";
import {
  computeConnectivity,
  ConnectedGroup,
  getGroupForSegment,
  getGroupForWire,
} from "@/components/stripboard/connectivity";
import { StripSegment } from "@/components/stripboard/stripSegments";

export function useStripSegments() {
  const board = useProjectStore((s) => s.board);
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);

  const segments = useMemo(
    () => computeStripSegments(board, components, componentDefs, netAssignments),
    [board, components, componentDefs, netAssignments]
  );

  const connectivity = useMemo(
    () => computeConnectivity(segments, board.wires),
    [segments, board.wires]
  );

  const conflictCount = useMemo(
    () => connectivity.filter((g) => g.hasConflict).length,
    [connectivity]
  );

  return { segments, connectivity, conflictCount };
}
