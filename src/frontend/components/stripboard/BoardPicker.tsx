"use client";

import { useEffect, useState } from "react";
import type { BoardPattern } from "@/types";
import { useProjectStore } from "@/store/useProjectStore";
import { useBoardLibraryStore } from "@/store/useBoardLibraryStore";
import { BUILTIN_BOARDS, builtinPattern, sizedPattern, snapCols } from "@/data/boards";
import { libraryPattern } from "@/data/customBoards";
import DropdownButton from "../DropdownButton";
import BoardEditor from "./BoardEditor";
import { stripboardMap } from "./boardPattern";
import { switchBoard } from "./switchBoard";
import { track } from "@/lib/track";

/** Which board the layout is on: plain stripboard, a built-in one or one of the user's own. */
export default function BoardPicker({ disabled }: { disabled?: boolean }) {
  const board = useProjectStore((s) => s.board);
  const libraryBoards = useBoardLibraryStore((s) => s.boards);
  const loadBoards = useBoardLibraryStore((s) => s.load);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  const pattern = board.pattern;
  // A custom board is one of the user's library, or the project's own: an
  // edited built-in board, one kept on this project only, or one from
  // someone else's library
  const inLibrary = !!pattern?.library && !!libraryBoards?.some((b) => b.id === pattern.library!.id);
  const own = !!pattern && !pattern.builtin && !inLibrary;
  const current = pattern?.builtin ?? (inLibrary ? `library:${pattern!.library!.id}` : own ? "own" : "stripboard");
  const tagClass = "shrink-0 text-[10px] uppercase tracking-wide text-[var(--copper)]";
  const item = (key: string, label: string, title: string, next: BoardPattern | null, close: () => void, mark?: string, update = false) => (
    <button
      key={key}
      onClick={() => {
        close();
        if (current !== key || update) switchBoard(next, "picker");
      }}
      title={title}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
    >
      <span className="w-3 shrink-0 text-[#113768] dark:text-[#5b9bd5]">{current === key ? "✓" : ""}</span>
      <span className="truncate">{label}</span>
      {mark && <span className={`ml-auto pl-3 ${tagClass}`}>{mark}</span>}
    </button>
  );
  const action = (label: string, onClick: () => void) => (
    <button onClick={onClick} className="w-full px-3 py-1.5 pl-8 text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
      {label}
    </button>
  );
  const divider = <div className="my-1 border-t border-neutral-200 dark:border-neutral-700" />;

  return (
    <>
      <DropdownButton
        label={<span className="truncate min-w-0">{pattern?.name ?? "Stripboard"}</span>}
        title={disabled ? "The board can be changed once auto-layout is done" : "The board the layout is on"}
        disabled={disabled}
        align="right"
        className="min-w-0"
        buttonClassName={(open) => `px-2 py-1 rounded border transition-colors whitespace-nowrap flex items-center gap-1 max-w-[16rem] disabled:opacity-40 ${open
          ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
          : "border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
        menuClassName="w-max min-w-[17rem] max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg dark:shadow-neutral-900/40 py-1 z-30"
      >
        {(close) => (
          <>
            {item("stripboard", "Stripboard", "Every row one strip across the board, any size, with auto-layout", null, close)}
            {divider}
            {/* a board bought in any size comes the size the layout is on now */}
            {BUILTIN_BOARDS.map((b) => item(b.id, b.name, b.summary,
              b.resizable ? sizedPattern(b, board.rows, snapCols(b, board.cols)) : builtinPattern(b), close))}
            {(own || (libraryBoards?.length ?? 0) > 0) && (
              <>
                {divider}
                <p className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-neutral-400">Custom boards</p>
                {own && item("own", pattern!.name, "This project's own board, not in your library", pattern!, close, "custom")}
                {(libraryBoards ?? []).map((lb) => {
                  const key = `library:${lb.id}`;
                  // this project's copy is older than the library's board
                  const behind = current === key && pattern?.library?.rev !== lb.rev;
                  return item(key, lb.board.name, behind ? "Changed in your library since: use the new version" : `${lb.board.name}, from your library`,
                    libraryPattern(lb), close, behind ? "update" : "library", behind);
                })}
              </>
            )}
            {divider}
            {pattern && action("Edit this board…", () => {
              close();
              track("board-editor-open", { source: "picker-edit" });
              setEditor("edit");
            })}
            {action("New board…", () => {
              close();
              track("board-editor-open", { source: "picker-new" });
              setEditor("new");
            })}
            {libraryBoards && (
              <a
                href="/boards"
                target="_blank"
                rel="noopener"
                onClick={close}
                className="block px-3 py-1.5 pl-8 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                Manage my boards ↗
              </a>
            )}
            <p className="mt-1 border-t border-neutral-200 dark:border-neutral-700 px-3 pt-1.5 pb-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              Auto-layout works on stripboard only.
            </p>
          </>
        )}
      </DropdownButton>
      {editor && (
        <BoardEditor
          editing={editor === "edit" && pattern ? { pattern, where: "project" } : undefined}
          start={pattern?.map ?? stripboardMap(board.rows, board.cols)}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
