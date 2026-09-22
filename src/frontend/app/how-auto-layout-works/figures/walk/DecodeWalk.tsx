"use client";

import { useMemo } from "react";
import type { LabFrame } from "@/components/stripboard/autoLayout5";
import { LAB, GENOME, PARTS } from "./lab";
import BoardView from "./BoardView";
import LaneView from "./LaneView";
import Player from "./Player";

// ── Section 6: the decode of one description, stage by stage ──
// Each figure replays the frames the real decoder recorded on the example.

function OrderChips({ order, pair }: { order: number[]; pair?: [number, number] }) {
  return (
    <div className="flex gap-1">
      {order.map((pi) => (
        <span key={pi} className={`w-8 h-7 rounded text-xs font-mono flex items-center justify-center border-2 ${pair && pair.includes(pi) ? "border-amber-500 bg-amber-50 dark:bg-amber-900/40" : "border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"} text-neutral-800 dark:text-neutral-100`}>
          {PARTS[pi].id}
        </span>
      ))}
    </div>
  );
}

function RelationsView({ f }: { f: LabFrame }) {
  const rels = f.relations ?? [];
  return (
    <div className="flex flex-col md:flex-row gap-4 text-xs text-neutral-700 dark:text-neutral-300">
      <div className="space-y-2">
        <div className="flex items-center gap-2"><span className="w-24 font-mono">first order</span><OrderChips order={GENOME.gp} pair={f.pair} /></div>
        <div className="flex items-center gap-2"><span className="w-24 font-mono">second order</span><OrderChips order={GENOME.gn} pair={f.pair} /></div>
      </div>
      <div className="flex-1 min-h-[7.5rem] font-mono grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 content-start">
        {rels.map((r, i) => (
          <span key={i} className={i === rels.length - 1 && f.pair ? "text-amber-600 dark:text-amber-400" : ""}>
            {PARTS[r.a].id} {r.rel === "left" ? "left of" : "above"} {PARTS[r.b].id}
          </span>
        ))}
      </div>
    </div>
  );
}

// the decoder writes strip-group splits back into the description it is
// given, so it gets a copy
const DECODED = LAB.decode(LAB.cloneG(GENOME), true);

export default function DecodeStage({ stage, caption }: { stage: 1 | 2 | 3 | 4 | 5 | 6; caption?: string }) {
  const frames = useMemo(() => DECODED.frames.filter((f) => f.stage === stage), [stage]);
  const size = useMemo(() => {
    let rows = 1, cols = 1;
    for (const f of frames) {
      if (f.board) { rows = Math.max(rows, f.board.rows); cols = Math.max(cols, f.board.cols); }
      if (f.lanes) for (const g of f.lanes.geo) rows = Math.max(rows, (g.bot !== g.top ? f.lanes.nodeY[g.bot] + 1 : f.lanes.nodeY[g.top] + g.h));
    }
    return { rows, cols };
  }, [frames]);
  if (!frames.length) return null;
  return (
    <Player
      demo="decode-walk"
      frames={frames}
      caption={caption}
      render={(f) =>
        f.relations ? <RelationsView f={f} /> : f.lanes ? <LaneView lanes={f.lanes} rows={size.rows + 1} /> : f.board ? <BoardView state={f.board} rows={size.rows} cols={size.cols} /> : null
      }
    />
  );
}
