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
  // Per-def-id span ranges for flexible parts (project auto-layout config)
  spanOverrides?: Record<string, { min: number; max: number }>;
  // Per-def-id body clearance halo in hole pitches (project auto-layout config)
  clearanceOverrides?: Record<string, number>;
  // Tidy second pass: allowed board area growth as a fraction (Infinity = any)
  tidyGrowth?: number;
}

export type AutoLayoutWorkerMessage =
  | { type: "progress"; progress: AutoLayoutProgress }
  | { type: "done"; result: AutoLayoutResult };

const ctx = self as unknown as {
  postMessage(msg: AutoLayoutWorkerMessage): void;
  onmessage: ((e: MessageEvent<AutoLayoutRequest>) => void) | null;
};

ctx.onmessage = (e) => {
  const { board, components, componentDefs, nets, netAssignments, engine, options, spanOverrides, clearanceOverrides, tidyGrowth } = e.data;
  const onProgress = (progress: AutoLayoutProgress) => {
    ctx.postMessage({ type: "progress", progress });
  };
  const defs = spanOverrides || clearanceOverrides
    ? componentDefs.map((d) => {
        if (!d.flexible) return d;
        const span = spanOverrides?.[d.id];
        const clearance = clearanceOverrides?.[d.id];
        if (!span && clearance === undefined) return d;
        return {
          ...d,
          ...(span ? { spanOverride: span } : {}),
          ...(clearance !== undefined ? { clearance } : {}),
        };
      })
    : componentDefs;
  const result = engine === "v1"
    ? computeAutoLayout(board, components, defs, nets, netAssignments, onProgress, options)
    : computeAutoLayout2(board, components, defs, nets, netAssignments, onProgress, tidyGrowth !== undefined ? { tidyGrowth } : undefined);
  ctx.postMessage({ type: "done", result });
};
