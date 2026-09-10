// ── The real layouter, opened up for the explainer ──
// The engine's lab hook hands out its decoder, its moves and its anneal
// loop on the example circuit, a 555 blinker, so every figure below shows
// the actual v5 code at work rather than a model of it.

import { computeAutoLayout5, type LabApi, type LabGenome } from "@/components/stripboard/autoLayout5";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import type { Board, Component, Net, NetAssignment } from "@/types";
import proj from "./example555.json";

const comps = (proj.components as unknown as Component[]).map((c) => ({ ...c, boardPos: null, rotation: 0 as const }));
const board = { ...(proj.board as unknown as Board), cuts: [], wires: [], lockedRows: false, lockedCols: false } as Board;

export const LAB: LabApi = (() => {
  let api: LabApi | null = null;
  computeAutoLayout5(board, comps, DEFAULT_COMPONENTS, proj.nets as unknown as Net[], proj.netAssignments as unknown as NetAssignment[], undefined, { lab: (a) => { api = a; } });
  if (!api) throw new Error("lab hook not called");
  return api;
})();
// Section 9 shows the finish under the assumptions it describes: cuts drilled
// out rather than knifed between two holes, and no wire lying on another.
// Those change what the decoder prefers, so they get a lab of their own.
export const LAB_FINISH: LabApi = (() => {
  let api: LabApi | null = null;
  computeAutoLayout5(board, comps, DEFAULT_COMPONENTS, proj.nets as unknown as Net[], proj.netAssignments as unknown as NetAssignment[], undefined,
    { lab: (a) => { api = a; }, drilledCutsOnly: true, noWireStacking: true });
  if (!api) throw new Error("lab hook not called");
  return api;
})();

export const PARTS = LAB.parts;
export const NETS = LAB.nets;

// the description every decode figure starts from: found by search so that
// one strip group cannot hold and one net needs a bus-row relay
export const GENOME: LabGenome = {
  gp: [1, 4, 5, 0, 2, 3],
  gn: [4, 0, 1, 5, 2, 3],
  rot: [0, 0, 0],
  hv: [0, 0, 0],
  br: [1, 1, 0],
  grp: [[118, 120, 119], [95, 94, 97, 94], [132, 133, 134, 127], [89, 90, 89], [75, 76], [72, 73]],
  gap: [2, 0, 1, 2, 0, 0],
  xgap: [0, 1, 0, 2, 0, 1],
};

// What the run of section 8 settles on: seed 1, 10,000 steps, default lab.
// Section 9 starts from it rather than annealing the same thing again. Every
// run there is deterministic, so this is a recording, not a guess; re-record
// it (LAB.run(1, 10000, ...) and take bestG) if the engine's scoring changes.
export const GENOME_RUN: LabGenome = {
  gp: [4, 5, 1, 3, 0, 2],
  gn: [4, 5, 1, 3, 0, 2],
  rot: [0, 0, 0],
  hv: [0, 0, 0],
  br: [1, 1, 0],
  grp: [[76, 77, 67], [62, 61, 60, 60], [84, 86, 80, 80], [56, 56, 56], [36, 36], [60, 60]],
  gap: [2, 1, 0, 0, 0, 0],
  xgap: [2, 0, 0, 1, 0, 0],
};

export const pinLabel = (pi: number, name: string) => `${PARTS[pi].id}.${name}`;
export const netColor = (n: number) => (n >= 0 && n < NETS.length ? NETS[n].color : "#D4A853");
