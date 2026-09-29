// ── The real layouter, opened up for the explainer ──
// The engine's lab hook hands out its decoder, its moves and its anneal
// loop on the example circuit, a 555 blinker, so every figure below shows
// the actual v5 code at work rather than a model of it.

import { useEffect, useState } from "react";
import { computeAutoLayout5, type LabApi, type LabBoard, type LabFrame, type LabGenome } from "@/components/stripboard/autoLayout5";
import { loadDecoderWasm } from "@/components/stripboard/v5wasm/loadWasm";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import type { Board, Component, Net, NetAssignment } from "@/types";
import proj from "./example555.json";
import walkGenome from "./walkGenome.json";
import moveSteps from "./moveSteps.json";
import recorded from "./recorded.json";

const comps = (proj.components as unknown as Component[]).map((c) => ({ ...c, boardPos: null, rotation: 0 as const }));
const board = { ...(proj.board as unknown as Board), cuts: [], wires: [], lockedRows: false, lockedCols: false } as Board;
const labOf = (wasm?: WebAssembly.Module): LabApi => {
  let api: LabApi | null = null;
  computeAutoLayout5(board, comps, DEFAULT_COMPONENTS, proj.nets as unknown as Net[], proj.netAssignments as unknown as NetAssignment[], undefined, { lab: (a) => { api = a; }, ...(wasm ? { wasm } : {}) });
  if (!api) throw new Error("lab hook not called");
  return api;
};

// The parts, nets and genome helpers, ready at once. Decoding, moves and
// runs need the decoder in WebAssembly: those come from useLiveLab.
export const LAB: LabApi = labOf();

let live: Promise<LabApi> | undefined;
/** The lab with the decoder loaded, or null while it loads. */
export function useLiveLab(): LabApi | null {
  const [lab, setLab] = useState<LabApi | null>(null);
  useEffect(() => {
    let on = true;
    (live ??= loadDecoderWasm().then(labOf)).then((l) => { if (on) setLab(l); });
    return () => { on = false; };
  }, []);
  return lab;
}

export const PARTS = LAB.parts;
export const NETS = LAB.nets;

// the description every decode figure starts from: found by search so that
// one strip group cannot hold and one net needs a bus-row relay
export const GENOME = walkGenome as LabGenome;

// Section 5: one proposal of each move kind on GENOME, in the order the
// section lists the moves. Each is the first proposal of its kind the move
// generator made (rng state 42) that decodes and changes the score; recorded
// 2026-09-29, when exactly one of them (the strip group merge) scored better.
// Recheck that when the decoder or its scoring changes.
export const MOVE_STEPS = moveSteps as LabGenome[];

// What the engine did with the example, recorded by
// tests/solver/recordExplainer.js (re-run it whenever the decoder, its
// scoring or the finish change): the decode of GENOME frame by frame, and
// both finishes, with drilled cuts and no stacked wires, of the description
// the section 8 run (seed 7, 25,000 steps) settles on.
export const DECODE_WALK = recorded.decodeWalk as unknown as LabFrame[];
export const FINISH_WALK = recorded.finishWalk as unknown as {
  start: LabBoard;
  router: { frames: LabFrame[]; price: number };
  repair: { frames: LabFrame[]; price: number; ok: boolean } | null;
};

export const netColor = (n: number) => (n >= 0 && n < NETS.length ? NETS[n].color : "#D4A853");
