import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { AutoLayoutProgress, AutoLayoutResult, computeAutoLayout } from "./autoLayout";

export interface AutoLayoutRequest {
  board: Board;
  components: Component[];
  componentDefs: ComponentDef[];
  nets: Net[];
  netAssignments: NetAssignment[];
}

export type AutoLayoutWorkerMessage =
  | { type: "progress"; progress: AutoLayoutProgress }
  | { type: "done"; result: AutoLayoutResult };

const ctx = self as unknown as {
  postMessage(msg: AutoLayoutWorkerMessage): void;
  onmessage: ((e: MessageEvent<AutoLayoutRequest>) => void) | null;
};

ctx.onmessage = (e) => {
  const { board, components, componentDefs, nets, netAssignments } = e.data;
  const result = computeAutoLayout(board, components, componentDefs, nets, netAssignments, (progress) => {
    ctx.postMessage({ type: "progress", progress });
  });
  ctx.postMessage({ type: "done", result });
};
