"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import CustomComponentEditor from "@/components/schematic/CustomComponentEditor";
import { SymbolThumbnail, packageLabel } from "@/components/schematic/ComponentLibrary";
import { COMPONENT_GROUP_LABELS } from "@/data/defaultComponents";
import { libraryDef, libraryPayload, partsFile, readPartsFile, registerPartSymbol, withPartId } from "@/data/customParts";
import {
  adoptFoundPart, createLibraryPart, deleteLibraryPart, getFoundParts, getLibraryPartUsage, getLibraryParts,
  importLibraryParts, type FoundPart, type LibraryPart, type LibraryPartUsage,
} from "@/lib/api";
import { useLibraryStore } from "@/store/useLibraryStore";
import { track } from "@/lib/track";
import type { ComponentDef } from "@/types";

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

const fileName = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part"}.parts.json`;

/** "DIP-8", "TO-92 / TO-220", or the size of a part drawn on the grid */
function bodyLabel(def: ComponentDef): string {
  return def.footprint ? packageLabel(def) : `Grid ${def.width} x ${def.height}, ${packageLabel(def)}`;
}

function matches(def: ComponentDef, query: string, group: string): boolean {
  if (group && (def.group ?? "") !== group) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [def.name, def.description ?? "", def.group ?? ""].join(" ").toLowerCase().includes(q);
}

export default function PartsClient() {
  const [parts, setParts] = useState<LibraryPart[] | null | undefined>(undefined);
  const [found, setFound] = useState<FoundPart[]>([]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [editor, setEditor] = useState<"new" | ComponentDef | null>(null);
  const [usage, setUsage] = useState<Record<string, LibraryPartUsage[]>>({});
  const [deleting, setDeleting] = useState<LibraryPart | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const ps = await getLibraryParts({ usage: true });
      setParts(ps);
      if (ps) {
        setFound(await getFoundParts());
        // The editor reads the library from the shared store
        useLibraryStore.getState().load();
      }
    } catch {
      setNotice({ text: "Could not load your parts. Please try again.", error: true });
    }
  }, []);

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
    } finally {
      setBusy(null);
    }
  }

  const importFile = (file: File) =>
    run("import", async () => {
      const incoming = readPartsFile(await file.text());
      const added = await importLibraryParts(incoming);
      track("parts-page-action", { action: "import", count: added.length });
      return `Added ${added.length} ${added.length === 1 ? "part" : "parts"} to your library.`;
    });

  const toggleUsage = async (id: string) => {
    if (usage[id]) {
      const next = { ...usage };
      delete next[id];
      setUsage(next);
      return;
    }
    try {
      setUsage({ ...usage, [id]: await getLibraryPartUsage(id) });
    } catch {
      setNotice({ text: "Could not look up where the part is used.", error: true });
    }
  };

  const defs = (parts ?? []).map((p) => ({ lp: p, def: libraryDef(p) }));
  const shown = defs.filter(({ def }) => matches(def, query, group));

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] text-neutral-900 dark:text-neutral-100">
      <SiteHeader breadcrumb="my parts" />
      <main className="max-w-4xl mx-auto w-full px-4 py-8">
        <h1 className="font-mono text-xl font-semibold mb-1">My parts</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-6">
          Custom parts you can use in every project. A project keeps its own copy; when you change a part here, you
          choose whether the copies in your projects follow.
        </p>

        {parts === undefined && <p className="text-sm text-neutral-500">Loading…</p>}

        {parts === null && (
          <div className={`${card} p-6`}>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
              Log in to keep custom parts in your own library and use them in all your projects.
            </p>
            <Link href="/" className={link}>Go to the start page to log in</Link>
          </div>
        )}

        {parts && (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your parts"
                aria-label="Search your parts"
                className="flex-1 min-w-[180px] px-2.5 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 focus:outline-none focus:border-[var(--copper)]"
              />
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                aria-label="Filter by group"
                className="px-2 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900"
              >
                <option value="">All groups</option>
                {COMPONENT_GROUP_LABELS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <button onClick={() => { track("part-editor-open", { source: "parts-page-new" }); setEditor("new"); }} className={primary}>New part</button>
              <button onClick={() => fileInput.current?.click()} disabled={busy !== null} className={button}>Import</button>
              <button
                onClick={() => {
                  track("parts-page-action", { action: "export-all", count: defs.length });
                  download("my-parts.parts.json", partsFile(defs.map((d) => d.def)));
                }}
                disabled={defs.length === 0}
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

            {parts.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-10">
                No parts yet. Make one with New part, import a parts file, or add a part from your projects below.
              </p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-10">No part matches.</p>
            ) : (
              <ul className="flex flex-col gap-2 mb-10">
                {shown.map(({ lp, def }) => (
                  <li key={lp.id} className={`${card} px-3 py-2`}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <SymbolThumbnail def={def} />
                      <div className="flex-1 min-w-[160px]">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{def.name}</span>
                          <span className="font-mono text-[11px] text-neutral-400">{bodyLabel(def)}</span>
                          {def.group && <span className="text-xs text-neutral-500">in {def.group}</span>}
                        </div>
                        {def.description && <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{def.description}</p>}
                        <p className="text-xs text-neutral-400 dark:text-neutral-500" suppressHydrationWarning>
                          {lp.used_in ? (
                            <button onClick={() => { track("parts-page-action", { action: "usage" }); toggleUsage(lp.id); }} className={link}>
                              Used in {lp.used_in} {lp.used_in === 1 ? "project" : "projects"}
                            </button>
                          ) : (
                            "Not used in a project yet"
                          )}
                          {" · "}changed {new Date(lp.updated_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 max-sm:w-full max-sm:pl-[68px] sm:justify-end sm:shrink-0">
                        <button onClick={() => { track("part-editor-open", { source: "parts-page-edit" }); setEditor(def); }} className={link}>Edit</button>
                        <button
                          onClick={() => run(`dup-${lp.id}`, async () => {
                            await createLibraryPart({ ...libraryPayload(def), name: `${def.name} (copy)` });
                            track("parts-page-action", { action: "duplicate" });
                          })}
                          disabled={busy !== null}
                          className={link}
                        >
                          Duplicate
                        </button>
                        <button onClick={() => { track("parts-page-action", { action: "export-one" }); download(fileName(def.name), partsFile([def])); }} className={link}>Export</button>
                        <button onClick={() => setDeleting(lp)} className="text-sm text-red-500 dark:text-red-400 hover:underline">Delete</button>
                      </div>
                    </div>
                    {usage[lp.id] && (
                      <ul className="mt-2 ml-16 text-sm flex flex-col gap-0.5">
                        {usage[lp.id].map((u) => (
                          <li key={u.edit_uuid}>
                            <Link href={`/project/${u.edit_uuid}`} className={link}>{u.name}</Link>
                            {u.placed > 0 && <span className="text-xs text-neutral-500"> · {u.placed} placed</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <h2 className="font-mono text-sm uppercase tracking-[0.2em] text-[var(--copper)] mb-2">Found in your projects</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              Custom parts that so far live only inside your projects. Adding one to your library also links it in the
              projects listed, so later changes can reach them.
            </p>
            {found.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing left to add.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {found.map((f) => {
                  const def = withPartId(f.part, `found-${f.key}`);
                  registerPartSymbol(def);
                  return (
                    <li key={f.key} className={`${card} px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2`}>
                      <SymbolThumbnail def={def} />
                      <div className="flex-1 min-w-[160px]">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{def.name}</span>
                          <span className="font-mono text-[11px] text-neutral-400">{bodyLabel(def)}</span>
                        </div>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          In{" "}
                          {f.projects.map((p, i) => (
                            <span key={p.edit_uuid}>
                              {i > 0 && ", "}
                              <Link href={`/project/${p.edit_uuid}`} className="hover:underline">{p.name}</Link>
                            </span>
                          ))}
                        </p>
                      </div>
                      <button
                        onClick={() => run(`adopt-${f.key}`, async () => {
                          const res = await adoptFoundPart(f.key);
                          track("parts-page-action", { action: "adopt", projects: res.linked_projects });
                          return `${def.name} is in your library now and linked in ${res.linked_projects} ${res.linked_projects === 1 ? "project" : "projects"}.`;
                        })}
                        disabled={busy !== null}
                        className={`${button} shrink-0`}
                      >
                        {busy === `adopt-${f.key}` ? "Adding…" : "Add to my library"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>

      {editor && (
        <CustomComponentEditor
          editing={editor === "new" ? undefined : { def: editor, where: "library" }}
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
              Delete <span className="font-medium">{deleting.part.name}</span>? Projects that use it keep their copy.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleting(null)} className={button}>Cancel</button>
              <button
                onClick={() => {
                  const target = deleting;
                  setDeleting(null);
                  run(`del-${target.id}`, async () => {
                    await deleteLibraryPart(target.id);
                    useLibraryStore.getState().remove(target.id);
                    track("part-delete", { source: "parts-page" });
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
