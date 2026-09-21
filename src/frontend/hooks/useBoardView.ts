import { useProjectStore } from "@/store/useProjectStore";
import { boardView } from "@/components/stripboard/offBoard";

/**
 * Components and net assignments as the board sees them: every off-board part
 * replaced by its solder pads. Anything that draws or analyses the board
 * reads these instead of the stored lists.
 */
export function useBoardView() {
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  return boardView(components, componentDefs, netAssignments);
}
