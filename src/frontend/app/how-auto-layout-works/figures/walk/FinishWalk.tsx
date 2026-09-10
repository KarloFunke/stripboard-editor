"use client";

import { useMemo } from "react";
import { GENOME_RUN, LAB_FINISH } from "./lab";
import BoardView from "./BoardView";
import Player from "./Player";

// ── Section 9: the finishing pass, stage by stage ──
// The description the section 8 run ends on, handed to the finish set up the
// way this section describes. The frames are the engine's own, recorded as it
// re-routes, buys lines and harvests them back; only the anneal that produced
// the description is a recording, since it always produces the same one.

export default function FinishWalk({ caption }: { caption?: string }) {
  const frames = useMemo(() => LAB_FINISH.finish(GENOME_RUN), []);

  // one canvas for every stage, so only the board moves
  const rows = Math.max(...frames.map((f) => f.board?.rows ?? 1));
  const cols = Math.max(...frames.map((f) => f.board?.cols ?? 1));
  return (
    <Player
      frames={frames}
      caption={caption}
      stepMs={2200}
      render={(f) => (f.board ? <BoardView state={f.board} rows={rows} cols={cols} /> : null)}
    />
  );
}
