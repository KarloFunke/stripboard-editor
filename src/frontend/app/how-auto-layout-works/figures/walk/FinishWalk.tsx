"use client";

import { useState } from "react";
import type { LabBoard, LabFrame } from "@/components/stripboard/autoLayout5";
import { FINISH_WALK } from "./lab";
import BoardView from "./BoardView";
import Player from "./Player";
import { trackDemo } from "../trackDemo";

// ── Section 9: both finishes of one description, stage by stage ──
// The description the section 8 run ends on, handed to each finish set up the
// way this section describes; a switch picks which finish to step through.
// The frames are the engine's own, recorded (lab.ts FINISH_WALK).

type Finish = "router" | "repair";

export default function FinishWalk() {
  const both = FINISH_WALK;
  const [which, setWhich] = useState<Finish>("router");
  const boards: LabBoard[] = [
    both.start,
    ...both.router.frames.map((f) => f.board),
    ...(both.repair?.frames ?? []).map((f) => f.board),
  ].filter((b): b is LabBoard => !!b);
  // one canvas size for every board, so only the board moves
  const rows = Math.max(...boards.map((b) => b.rows));
  const cols = Math.max(...boards.map((b) => b.cols));
  const draw = (f: LabFrame) => (f.board ? <BoardView state={f.board} rows={rows} cols={cols} /> : null);

  const repair = both.repair;
  const shown = which === "repair" && repair ? repair : both.router;
  const frames: LabFrame[] = [
    {
      stage: 7,
      msg: "What the annealer hands over: the board its decoder scored. It is complete and it is what the whole search was aimed at, but the decoder is a fast approximation, so nothing about its cuts and wires is final.",
      board: both.start,
    },
    ...shown.frames,
  ];
  const router = Math.round(both.router.price);
  const verdict = !repair
    ? `Start over ends at a price of ${router}.`
    : !repair.ok
      ? `Start over ends at a price of ${router}. The repair comes to ${Math.round(repair.price)}, but its board is not clean, so it cannot be used.`
      : `Start over ends at a price of ${router}, the repair at ${Math.round(repair.price)}, so here the ${repair.price < both.router.price ? "repaired" : "rebuilt"} board is the one you get.`;
  const how = which === "router"
    ? "Start over: only where the parts stand is kept. Cuts and wires are worked out again from scratch, and blank lines are bought where a wire needs one and handed back once a tighter arrangement turns up."
    : "Repair: the board is mended instead of rebuilt. Only what the editor's rules reject is touched, and no wire ever changes which two strips it joins.";

  const seg = (on: boolean) =>
    `px-2 py-1 text-xs border ${on ? "border-[var(--copper)] text-[var(--copper)] bg-white dark:bg-neutral-900" : "border-neutral-300 dark:border-neutral-600 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`;
  const pick = (w: Finish) => { trackDemo("finish-walk", w); setWhich(w); };
  const toggle = (
    <span className="inline-flex">
      <button className={`${seg(which === "router")} rounded-l`} onClick={() => pick("router")}>Start over</button>
      {repair && <button className={`${seg(which === "repair")} rounded-r -ml-px`} onClick={() => pick("repair")}>Repair</button>}
    </span>
  );

  return <Player key={which} demo="finish-walk" frames={frames} render={draw} stepMs={2200} controls={toggle} caption={`${how} ${verdict}`} />;
}
