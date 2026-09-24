"use client";

import { useMemo, type ReactNode } from "react";
import type { LabBoard, LabFrame } from "@/components/stripboard/autoLayout5";
import { GENOME_RUN, LAB_FINISH } from "./lab";
import BoardView from "./BoardView";
import Player from "./Player";

// ── Section 9: both finishes of one description, stage by stage ──
// The description the section 8 run ends on, handed to each finish set up the
// way this section describes. The frames are the engine's own; only the anneal
// that produced the description is a recording, since it always produces the
// same one.

const Lead = ({ children }: { children: ReactNode }) => (
  <h4 className="font-mono text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-7 mb-2">{children}</h4>
);

export default function FinishWalk({ caption }: { caption?: string }) {
  const both = useMemo(() => LAB_FINISH.finishBoth(GENOME_RUN), []);
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
  const repairWins = !!repair && repair.ok && repair.price < both.router.price;
  const priceOf = (p: number) => Math.round(p);
  const startFrame: LabFrame[] = [{
    stage: 7,
    msg: "What the annealer hands over: the board its decoder scored. It is complete and it is what the whole search was aimed at, but the decoder is a fast approximation, so nothing about its cuts and wires is final.",
    board: both.start,
  }];

  return (
    <div>
      <Player demo="finish-start" frames={startFrame} render={draw} />
      <Lead>Start over: the thorough router</Lead>
      <Player
        demo="finish-walk"
        frames={both.router.frames}
        render={draw}
        stepMs={2200}
        caption={`The board keeps only where the parts stand. Cuts and wires are worked out again from scratch, blank lines are bought where a wire needs one and handed back once the router finds a tighter arrangement. Final price ${priceOf(both.router.price)}.`}
      />
      {repair && (
        <>
          <Lead>Repair: keep what the annealer found</Lead>
          <Player
            demo="finish-repair"
            frames={repair.frames}
            render={draw}
            stepMs={2200}
            caption={`The same board, mended instead of rebuilt. Only what the editor's rules reject is touched, and no wire ever changes which two strips it joins. Final price ${priceOf(repair.price)}${repair.ok ? "" : ", but this board is not clean, so it cannot be used"}.`}
          />
        </>
      )}

      {caption && <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-snug mb-3">{caption}</p>}
    </div>
  );
}
