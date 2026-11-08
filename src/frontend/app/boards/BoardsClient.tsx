"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import BoardEditor from "@/components/stripboard/BoardEditor";
import BoardThumbnail from "@/components/stripboard/BoardThumbnail";
import { patternSize } from "@/components/stripboard/boardPattern";
import { boardsFile, libraryPattern, readBoardsFile } from "@/data/customBoards";
import {
  createLibraryBoard, deleteLibraryBoard, getLibraryBoardUsage, getLibraryBoards, importLibraryBoards,
  type LibraryBoard, type LibraryBoardUsage,
} from "@/lib/api";
import { useBoardLibraryStore } from "@/store/useBoardLibraryStore";
import { track } from "@/lib/track";

const button =
  "font-mono text-sm px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors disabled:opacity-40";
const primary = "font-mono text-sm px-3 py-1.5 rounded bg-[#113768] text-white hover:bg-[#0d2a50] transition-colors disabled:opacity-40";
const link = "text-sm text-[#113768] dark:text-[#5b9bd5] hover:underline";
const card = "bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const fileName = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board"}.boards.json`;

export default function BoardsClient() {
  const [boards, setBoards] = useState<LibraryBoard[] | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<"new" | LibraryBoard | null>(null);
  const [usage, setUsage] = useState<Record<string, LibraryBoardUsage[]>>({});
  const [deleting, setDeleting] = useState<LibraryBoard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    () =>
      getLibraryBoards({ usage: true })
        .then((bs) => {
          setBoards(bs);
          // The editor reads the library from the shared store
          if (bs) useBoardLibraryStore.getState().load();
        })
        .catch(() => setNotice({ text: "Could not load your boards. Please try again.", error: true })),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, task: () => Promise<string | void>) {
    setBusy(key);
    setNotice(null);
    try {
      const text = await task();
      if (text) setNotice({ text });
      await load();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Something went wrong", error: true });
    }
    setBusy(null);
  }

  const importFile = (file: File) =>
    run("import", async () => {
      const added = await importLibraryBoards(readBoardsFile(await file.text()));
      track("boards-page-action", { action: "import", count: added.length });
      return `Added ${added.length} ${added.length === 1 ? "board" : "boards"} to your library.`;
    });

  const toggleUsage = async (id: string) => {
    if (usage[id]) {
      const next = { ...usage };
      delete next[id];
      setUsage(next);
      return;
    }
    try {
      setUsage({ ...usage, [id]: await getLibraryBoardUsage(id) });
    } catch {
      setNotice({ text: "Could not look up where the board is used.", error: true });
    }
  };

  const shown = (boards ?? []).filter((b) => b.board.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] text-neutral-900 dark:text-neutral-100">
      <SiteHeader breadcrumb="my boards" />
      <main className="max-w-4xl mx-auto w-full px-4 py-8">
        <h1 className="font-mono text-xl font-semibold mb-1">My boards</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-6">
          Boards of your own, for boards the editor does not know. A project keeps its own copy; when you change a board
          here, you choose whether the copies in your projects follow.
        </p>

        {boards === undefined && <p className="text-sm text-neutral-500">Loading…</p>}

        {boards === null && (
          <div className={`${card} p-6`}>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              Log in to keep boards of your own and use them in all your projects.
            </p>
            <Link href="/" className={link}>Go to the start page to log in</Link>
          </div>
        )}

        {boards && (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your boards"
                aria-label="Search your boards"
                className="flex-1 min-w-[180px] px-2.5 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 focus:outline-none focus:border-[var(--copper)]"
              />
              <button onClick={() => { track("board-editor-open", { source: "boards-page-new" }); setEditor("new"); }} className={primary}>New board</button>
              <button onClick={() => fileInput.current?.click()} disabled={busy !== null} className={button}>Import</button>
              <button
                onClick={() => {
                  track("boards-page-action", { action: "export-all", count: boards.length });
                  download("my-boards.boards.json", boardsFile(boards.map((b) => b.board)));
                }}
                disabled={boards.length === 0}
                className={button}
              >
                Export all
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) importFile(file);
                }}
              />
            </div>

            {notice && (
              <p className={`text-sm mb-4 ${notice.error ? "text-red-600" : "text-green-700 dark:text-green-400"}`} role="status">
                {notice.text}
              </p>
            )}

            {boards.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                No boards yet. Make one with New board, or import a boards file.
              </p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No board matches.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {shown.map((lb) => {
                  const { rows, cols } = patternSize(lb.board.map);
                  return (
                    <li key={lb.id} className={`${card} px-3 py-2`}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <div className="w-14 h-14 flex items-center justify-center">
                          <BoardThumbnail map={lb.board.map} size={56} />
                        </div>
                        <div className="flex-1 min-w-[160px]">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">{lb.board.name}</span>
                            <span className="font-mono text-[11px] text-neutral-400">{rows} x {cols} holes</span>
                          </div>
                          <p className="text-xs text-neutral-400 dark:text-neutral-500" suppressHydrationWarning>
                            {lb.used_in ? (
                              <button onClick={() => { track("boards-page-action", { action: "usage" }); toggleUsage(lb.id); }} className={link}>
                                Used in {lb.used_in} {lb.used_in === 1 ? "project" : "projects"}
                              </button>
                            ) : (
                              "Not used in a project yet"
                            )}
                            {" · "}changed {new Date(lb.updated_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 max-sm:w-full max-sm:pl-[68px] sm:justify-end sm:shrink-0">
                          <button onClick={() => { track("board-editor-open", { source: "boards-page-edit" }); setEditor(lb); }} className={link}>Edit</button>
                          <button
                            onClick={() => run(`dup-${lb.id}`, async () => {
                              await createLibraryBoard({ ...lb.board, name: `${lb.board.name} (copy)`.slice(0, 80) });
                              track("boards-page-action", { action: "duplicate" });
                            })}
                            disabled={busy !== null}
                            className={link}
                          >
                            Duplicate
                          </button>
                          <button onClick={() => { track("boards-page-action", { action: "export-one" }); download(fileName(lb.board.name), boardsFile([lb.board])); }} className={link}>Export</button>
                          <button onClick={() => setDeleting(lb)} className="text-sm text-red-500 dark:text-red-400 hover:underline">Delete</button>
                        </div>
                      </div>
                      {usage[lb.id] && (
                        <ul className="mt-2 ml-16 text-sm flex flex-col gap-0.5">
                          {usage[lb.id].map((u) => (
                            <li key={u.edit_uuid}>
                              <Link href={`/project/${u.edit_uuid}`} className={link}>{u.name}</Link>
                              {u.placed > 0 && <span className="text-xs text-neutral-500"> · {u.placed} placed</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>

      {editor && (
        <BoardEditor
          editing={editor === "new" ? undefined : { pattern: libraryPattern(editor), where: "library" }}
          libraryOnly
          onClose={() => {
            setEditor(null);
            load();
          }}
        />
      )}

      {deleting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDeleting(null)}>
          <div className={`${card} p-6 w-[calc(100%-2rem)] max-w-sm`} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-2">Delete from your library</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
              Delete <span className="font-medium">{deleting.board.name}</span>? Projects on it keep their copy.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleting(null)} className={button}>Cancel</button>
              <button
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  run(`del-${target.id}`, async () => {
                    await deleteLibraryBoard(target.id);
                    useBoardLibraryStore.getState().remove(target.id);
                    track("board-delete", { source: "boards-page" });
                  });
                }}
                className="font-mono text-sm px-3 py-1.5 rounded bg-red-500 text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
