import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { AutoLayoutOptions, computeAutoLayout } from "./autoLayout";
import { AutoLayoutProgress, AutoLayoutResult } from "./layoutTypes";
import { computeAutoLayout5 } from "./autoLayout5";
import { computeAutoLayout5Stack } from "./autoLayout5Stack";
import { wireMessScore } from "./layout2/tidyScore";
import { wireStackDepth } from "./flexGeometry";
import { priceResult } from "./layout2/boardPrice";
import { expandOffBoard } from "./offBoard";
import { loadDecoderWasm, loadRouterWasm } from "./v5wasm/loadWasm";

export interface AutoLayoutRequest {
  board: Board;
  components: Component[];
  componentDefs: ComponentDef[];
  nets: Net[];
  netAssignments: NetAssignment[];
  // "v5" = the annealed skeleton layouter, for full runs.
  // "v1" = the classic optimizer; still used for scoped re-layouts, which
  // must keep everything else (and the board size) fixed.
  engine: "v1" | "v5";
  options?: AutoLayoutOptions;
  // Free board lines kept between all parts (project auto-layout config)
  partSpacing?: number;
  // Only sever strips by drilling holes (project auto-layout config)
  drilledCutsOnly?: boolean;
  // Solve exactly this input ordering (parallel permutation search): the
  // editor spreads indices over several workers and compares the returned
  // scores. Undefined = plain single solve of the caller's own ordering.
  // For engine "v5" this is the seed index instead.
  permutationIndex?: number;
  // v5: anneal budget per seed (undefined = size-scaled default)
  v5Moves?: number;
  // v5: moves per seed as a multiple of the pin-count formula (effortMoves)
  v5Effort?: number;
  // v5: no wire may run on top of another in one channel
  noWireStacking?: boolean;
  // Resistors and diodes may stand on one lead (project auto-layout config)
  allowStanding?: boolean;
  // v5: the stacked solve under this pin cap instead of a joint seed (big
  // boards); permutationIndex is the seed of its leaf anneals
  v5Stack?: number;
  // v5: only time this many decodes of random genomes (answered with a
  // "probe" message), for the settings' first-run time estimate
  v5Probe?: number;
}

export type AutoLayoutWorkerMessage =
  | { type: "progress"; progress: AutoLayoutProgress }
  // score: the finished board's price (priceResult), lower is better.
  // crossings: wire-over-part crossings, for the guarded final pick —
  // compare on (quality, crossings, score); lets the editor pick across
  // workers without letting crossings trade up.
  | { type: "done"; result: AutoLayoutResult; score?: number; crossings?: number }
  | { type: "probe"; msPerDecode: number };

const ctx = self as unknown as {
  postMessage(msg: AutoLayoutWorkerMessage): void;
  onmessage: ((e: MessageEvent<AutoLayoutRequest>) => void) | null;
};

// a v5 layout's wall-time limit in seconds, whatever its effort
const V5_GUARD_S = 1200;

// An error thrown in the async handler would only reject its promise, which
// the page never hears about: rethrown outside it, it reaches worker.onerror
// (the editor's "Auto-layout failed")
ctx.onmessage = (e) => {
  handle(e).catch((err) => setTimeout(() => { throw err; }));
};

async function handle(e: MessageEvent<AutoLayoutRequest>) {
  // the wire router, for every engine
  await loadRouterWasm();
  const { board, components, componentDefs, nets, netAssignments, engine, options, partSpacing, drilledCutsOnly, permutationIndex, v5Moves, v5Effort, noWireStacking, allowStanding, v5Stack, v5Probe } = e.data;
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
  // engine v5
  const wasm = await loadDecoderWasm();
  if (v5Probe) {
    let msPerDecode = 0;
    computeAutoLayout5(board, components, defs, nets, netAssignments, undefined, {
      speedProbe: v5Probe, onSpeedProbe: (ms) => { msPerDecode = ms; }, wasm,
    });
    ctx.postMessage({ type: "probe", msPerDecode });
    return;
  }
  const v5Opts = {
    ...(v5Moves !== undefined ? { moves: v5Moves } : {}),
    ...(v5Effort !== undefined ? { effort: v5Effort } : {}),
    // the effort sets the moves; the clock only stops a run that would take
    // unreasonably long on a slow machine
    timeBudgetMs: V5_GUARD_S * 1000,
    ...(drilledCutsOnly ? { drilledCutsOnly: true } : {}),
    ...(noWireStacking ? { noWireStacking: true } : {}),
    // every new best of the walk's second half is finished exactly too, and
    // the cheapest board wins: a few seconds a seed, never a worse board
    exactBest: true,
    // a proposal whose orders contradict a strip-sharing tie is refused
    // instead of the tie being dissolved: -13 % on big boards, -3 % on the
    // corpus, faster on small ones (2026-09-25)
    protectTies: true,
    wasm,
  };
  const result = v5Stack !== undefined
    ? computeAutoLayout5Stack(board, components, defs, nets, netAssignments, onProgress, {
        pinCap: v5Stack,
        ...(permutationIndex !== undefined ? { seedBase: permutationIndex } : {}),
        ...(v5Moves !== undefined ? { moves: v5Moves } : {}),
        ...(v5Effort !== undefined ? { effort: v5Effort } : {}),
        timeBudgetMs: V5_GUARD_S * 1000,
        ...(drilledCutsOnly ? { drilledCutsOnly: true } : {}),
        ...(noWireStacking ? { noWireStacking: true } : {}),
        exactBest: true,
        protectTies: true,
        wasm,
      })
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
    score: priceResult(result, board, expandOffBoard(components, defs, netAssignments).components, defs, drilledCutsOnly),
    crossings: wireMessScore(result, components, defs).crossings + offAxis + stacked,
  });
}
