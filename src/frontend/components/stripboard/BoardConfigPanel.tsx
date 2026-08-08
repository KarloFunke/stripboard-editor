"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { BOARD_PRESETS, findPreset, presetBoard, presetSize } from "./boardPresets";
import { parseBoardMap, formatBoardMap } from "./boardMap";
import { boardTopology } from "./boardTopology";

// Written out as it is shown. The opening backtick sits on its own line so
// every row of the table starts at column 0 here too — the columns line up
// in the editor, which is the only way a hand-aligned block stays aligned.
const SYNTAX =
`0     a hole              -   copper, left to right
.     no hole              |   copper, up to down  (own line)
A-Z   a tagged hole        :   snap line — a groove between two
                               holes, so it costs no row or column

A digit is a hole, a letter tags the run it belongs to.

define NAME = <line>   name a line;  {NAME} pastes it
define NAME ... end    name a block of lines
repeat N ... end       repeat the enclosed lines

Blocks paste side by side, joined row by row, so a bigger
board is written out of the piece it repeats.`;

const EXAMPLE =
`define quarter
  P 0-0-0 0-0-0 N     a rail, two runs of three, a rail
  |             |     the rails carry on down
end

{quarter}:{quarter}     two of them, the V-cut between`;

/**
 * The board editor. A board is described by its map — a picture of the
 * copper — so this is a text editor with the stocked boards as starting
 * points, rather than a form per kind of feature.
 */
export default function BoardConfigPanel({ onClose }: { onClose: () => void }) {
  const board = useProjectStore((s) => s.board);
  const setBoardLayout = useProjectStore((s) => s.setBoardLayout);
  const applyBoardPreset = useProjectStore((s) => s.applyBoardPreset);

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = panel?.parentElement;
    if (!panel || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const margin = 8;
    setPos({
      top: a.bottom + 4,
      left: Math.max(margin, Math.min(a.right - panel.offsetWidth, window.innerWidth - margin - panel.offsetWidth)),
    });
  }, []);

  // The map the board currently has. A board still on the old rails model,
  // or a plain veroboard, is shown as the map it amounts to, so editing is
  // always editing a map.
  const currentMap = useMemo(() => {
    if (board.layout?.map) return board.layout.map;
    return formatBoardMap(boardTopology(board));
  }, [board]);

  const [draft, setDraft] = useState(currentMap);
  const [dirty, setDirty] = useState(false);
  const shown = dirty ? draft : currentMap;

  const parsed = useMemo(() => parseBoardMap(shown), [shown]);
  const errors = parsed.issues;
  const size = parsed.rows > 0 ? { rows: parsed.rows, cols: parsed.cols } : null;
  const changed = shown !== currentMap;

  const apply = () => {
    if (!size) return;
    setBoardLayout({ map: shown });
    setDirty(false);
  };

  const usePreset = (id: string) => {
    applyBoardPreset(id);
    const p = findPreset(id);
    if (p) setDraft(presetBoard(p).layout.map ?? "");
    setDirty(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={panelRef}
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
        className="fixed z-50 w-[38rem] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg dark:shadow-neutral-900/50 p-4"
      >
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Board</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
          A board is drawn as a map of its copper: holes on the even columns, what joins them
          in between. The map is the whole truth about the board — it sets the size too — so
          anything you can draw, you can build on.
        </p>

        <p className="mt-4 text-xs font-semibold text-neutral-700 dark:text-neutral-200">Start from</p>
        <div className="mt-1.5 flex flex-col gap-1">
          {BOARD_PRESETS.map((preset) => {
            const active = board.layout?.map === preset.map;
            const s = presetSize(preset);
            return (
              <button
                key={preset.id}
                onClick={() => usePreset(preset.id)}
                className={`text-left rounded border px-2.5 py-1.5 transition-colors ${active
                  ? "border-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:bg-[#5b9bd5]/15"
                  : "border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
              >
                <span className="block text-xs font-medium text-neutral-900 dark:text-neutral-100">
                  {preset.name}
                  <span className="ml-1.5 font-normal text-neutral-500 dark:text-neutral-400">
                    {s.rows} × {s.cols}
                  </span>
                </span>
                <span className="block text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                  {preset.summary}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-baseline justify-between">
          <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">Board map</p>
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {size ? `${size.rows} rows × ${size.cols} columns` : "nothing to build yet"}
          </span>
        </div>
        <textarea
          value={shown}
          spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
          rows={14}
          className="mt-1.5 w-full font-mono text-[11px] leading-[1.35] border border-neutral-300 dark:border-neutral-600 rounded p-2 text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900 outline-none focus:border-blue-400 whitespace-pre overflow-x-auto"
        />

        {errors.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {errors.slice(0, 6).map((e, i) => (
              <li key={i} className="text-[11px] text-red-600 dark:text-red-400">
                line {e.line}: {e.message}
              </li>
            ))}
            {errors.length > 6 && (
              <li className="text-[11px] text-neutral-500">…and {errors.length - 6} more</li>
            )}
          </ul>
        )}

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={apply}
            disabled={!changed || !size}
            className="rounded border border-[#113768] dark:border-[#5b9bd5] px-2.5 py-1 text-xs text-[#113768] dark:text-[#5b9bd5] enabled:hover:bg-[#113768]/10 dark:enabled:hover:bg-[#5b9bd5]/15 disabled:opacity-40 transition-colors"
          >
            Apply to board
          </button>
          {changed && (
            <button
              onClick={() => { setDraft(currentMap); setDirty(false); }}
              className="rounded border border-neutral-300 dark:border-neutral-600 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
            >
              Revert
            </button>
          )}
          <button
            onClick={() => {
              // Macros are a convenience for writing; expanding shows the
              // picture they stand for, which is easier to check by eye.
              setDraft(size ? formatBoardMap(parsed) : shown);
              setDirty(true);
            }}
            className="ml-auto rounded border border-neutral-300 dark:border-neutral-600 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          >
            Expand macros
          </button>
        </div>
        {changed && errors.length === 0 && (
          <p className="mt-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            Applying resizes the board to the map and clears cuts and wires that no longer
            land on copper.
          </p>
        )}

        <details className="mt-3">
          <summary className="text-xs font-semibold text-neutral-700 dark:text-neutral-200 cursor-pointer select-none">
            Syntax
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] leading-snug text-neutral-600 dark:text-neutral-300">{SYNTAX}</pre>
          <pre className="mt-2 font-mono text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">{EXAMPLE}</pre>
        </details>
      </div>
    </>
  );
}
