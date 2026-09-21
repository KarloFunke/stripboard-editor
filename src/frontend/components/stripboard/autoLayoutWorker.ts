import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { AutoLayoutOptions, computeAutoLayout } from "./autoLayout";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { computeAutoLayout2, rateResult } from "./autoLayout2";
import { computeAutoLayout5 } from "./autoLayout5";
import { computeAutoLayout5Split } from "./autoLayout5Split";
import { wireMessScore } from "./layout2/tidyScore";
import { wireStackDepth } from "./flexGeometry";

export interface AutoLayoutRequest {
  board: Board;
  components: Component[];
  componentDefs: ComponentDef[];
  nets: Net[];
  netAssignments: NetAssignment[];
  // "v2" (default) = strip-first layouter, chooses its own board size.
  // "v1" = the classic optimizer; still used for scoped re-layouts, which
  // must keep everything else (and the board size) fixed.
  // "v5" = the annealed skeleton layouter (beta), for direct comparison.
  engine?: "v1" | "v2" | "v5";
  options?: AutoLayoutOptions;
  // Per-def-id span ranges for flexible parts (project auto-layout config)
  // Free board lines kept between all parts (project auto-layout config)
  partSpacing?: number;
  // Tidy second pass: allowed board area growth as a fraction (Infinity = any)
  tidyGrowth?: number;
  // Only sever strips by drilling holes (project auto-layout config)
  drilledCutsOnly?: boolean;
  // Solve exactly this input ordering (parallel permutation search): the
  // editor spreads indices over several workers and compares the returned
  // scores. Undefined = plain single solve of the caller's own ordering.
  // For engine "v5" this is the seed index instead.
  permutationIndex?: number;
  // v5: anneal budget per seed (undefined = size-scaled default)
  v5Moves?: number;
  v5TimeS?: number;
  v5MsPerMove?: number;
  // v5: solve this bipartition variant (two halves under a common locked
  // dimension, composed) instead of a joint seed
  v5Split?: number;
  // v5: no wire may run on top of another in one channel
  noWireStacking?: boolean;
  // Resistors and diodes may stand on one lead (project auto-layout config)
  allowStanding?: boolean;
  // v5 split: first seed of the halves' portfolio (one per board)
  v5SeedBase?: number;
}

export type AutoLayoutWorkerMessage =
  | { type: "progress"; progress: AutoLayoutProgress }
  // score: rateResult of the finished board (v2 only) — lower is better.
  // crossings: wire-over-part crossings, for the guarded final pick —
  // compare on (quality, crossings, score); lets the editor pick across
  // workers without letting crossings trade up.
  | { type: "done"; result: AutoLayoutResult; score?: number; crossings?: number; msPerMove?: number };

const ctx = self as unknown as {
  postMessage(msg: AutoLayoutWorkerMessage): void;
  onmessage: ((e: MessageEvent<AutoLayoutRequest>) => void) | null;
};

ctx.onmessage = (e) => {
  const { board, components, componentDefs, nets, netAssignments, engine, options, partSpacing, tidyGrowth, drilledCutsOnly, permutationIndex, v5Moves, v5TimeS, v5MsPerMove, v5Split, noWireStacking, allowStanding, v5SeedBase } = e.data;
  const onProgress = (progress: AutoLayoutProgress) => {
    ctx.postMessage({ type: "progress", progress });
  };
  // The project's two layout choices travel on the defs: extra spacing is a
  // clearance every part asks for, rigid ones included.
  const defs = partSpacing || allowStanding
    ? componentDefs.map((d) => ({
        ...d,
        ...(partSpacing ? { clearance: partSpacing } : {}),
        ...(allowStanding && d.flexible ? { allowStanding: true } : {}),
      }))
    : componentDefs;
  if (engine === "v1") {
    const result = computeAutoLayout(board, components, defs, nets, netAssignments, onProgress, {
      ...options,
      ...(drilledCutsOnly ? { drilledCutsOnly: true } : {}),
    });
    ctx.postMessage({ type: "done", result });
    return;
  }
  if (engine === "v5") {
    let msPerMove: number | undefined;
    const v5Opts = {
      ...(v5Moves !== undefined ? { moves: v5Moves } : {}),
      ...(v5TimeS !== undefined ? { timeBudgetMs: v5TimeS * 1000, onBudget: (b: { msPerMove: number }) => { msPerMove = b.msPerMove; } } : {}),
      ...(v5MsPerMove !== undefined ? { msPerMoveHint: v5MsPerMove } : {}),
      ...(drilledCutsOnly ? { drilledCutsOnly: true } : {}),
      ...(noWireStacking ? { noWireStacking: true } : {}),
    };
    const result = v5Split !== undefined
      ? computeAutoLayout5Split(board, components, defs, nets, netAssignments, onProgress, { variant: v5Split, ...(v5SeedBase !== undefined ? { seedBase: v5SeedBase } : {}), ...v5Opts })
      : computeAutoLayout5(board, components, defs, nets, netAssignments, onProgress, {
          ...(permutationIndex !== undefined ? { seedIndex: permutationIndex } : {}),
          ...v5Opts,
        });
    // the guard metric for v5 is total wire mess: off-axis wires count like
    // crossings (presentation-clean first), and so do stacked wires when
    // stacking is forbidden
    const offAxis = result.wires.filter((w) => w.from.col !== w.to.col).length;
    const stacked = noWireStacking
      ? result.wires.filter((w, i) => wireStackDepth(w.from, w.to, result.wires.slice(0, i)) > 0).length
      : 0;
    ctx.postMessage({
      type: "done",
      result,
      score: rateResult(result, board, components, defs, drilledCutsOnly),
      crossings: wireMessScore(result, components, defs).crossings + offAxis + stacked,
      ...(msPerMove !== undefined ? { msPerMove } : {}),
    });
    return;
  }
  const result = computeAutoLayout2(board, components, defs, nets, netAssignments, onProgress, {
    ...(tidyGrowth !== undefined ? { tidyGrowth } : {}),
    ...(permutationIndex !== undefined ? { permutationIndex } : {}),
    ...(drilledCutsOnly ? { drilledCutsOnly: true } : {}),
  });
  ctx.postMessage({
    type: "done",
    result,
    score: rateResult(result, board, components, defs, drilledCutsOnly),
    crossings: wireMessScore(result, components, defs).crossings,
  });
};
