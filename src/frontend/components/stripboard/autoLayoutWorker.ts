import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { AutoLayoutOptions, AutoLayoutProgress, AutoLayoutResult, computeAutoLayout } from "./autoLayout";
import { computeAutoLayout2 } from "./autoLayout2";

export interface AutoLayoutRequest {
  board: Board;
  components: Component[];
  componentDefs: ComponentDef[];
  nets: Net[];
  netAssignments: NetAssignment[];
  // "v2" (default) = strip-first layouter, chooses its own board size.
  // "v1" = the classic optimizer; still used for scoped re-layouts, which
  // must keep everything else (and the board size) fixed.
  engine?: "v1" | "v2";
  options?: AutoLayoutOptions;
}

export type AutoLayoutWorkerMessage =
  | { type: "progress"; progress: AutoLayoutProgress }
  | { type: "done"; result: AutoLayoutResult };

const ctx = self as unknown as {
  postMessage(msg: AutoLayoutWorkerMessage): void;
  onmessage: ((e: MessageEvent<AutoLayoutRequest>) => void) | null;
};

ctx.onmessage = (e) => {
  const { board, components, componentDefs, nets, netAssignments, engine, options } = e.data;
  const onProgress = (progress: AutoLayoutProgress) => {
    ctx.postMessage({ type: "progress", progress });
  };
  const result = engine === "v1"
    ? computeAutoLayout(board, components, componentDefs, nets, netAssignments, onProgress, options)
    : computeAutoLayout2(board, components, componentDefs, nets, netAssignments, onProgress);
  ctx.postMessage({ type: "done", result });
};
