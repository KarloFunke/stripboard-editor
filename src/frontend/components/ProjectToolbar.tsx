"use client";

import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getMe, logout, claimProject, migrateProjectData, type User } from "@/lib/api";
import { track } from "@/lib/track";
import { toKicadNetlist, collectGeneratedFootprints, FOOTPRINT_LIB_NICKNAME } from "@/lib/netlistExport";
import { createZip } from "@/lib/zip";
import ThemeToggle from "./ThemeToggle";
import PrintPreview from "./print/PrintPreview";
import AuthModal from "./AuthModal";

interface Props {
  editUuid?: string;
  viewUuid?: string | null;
  onSave?: () => Promise<boolean>;
  saving?: boolean;
  lastSaved?: Date | null;
  saveError?: boolean;
  autoSave?: boolean;
  onToggleAutoSave?: () => void;
}

function FeedbackButton({
  onClick,
  label,
  feedbackLabel,
  disabled,
}: {
  onClick: () => void;
  label: string;
  feedbackLabel?: string;
  disabled?: boolean;
}) {
  const [feedback, setFeedback] = useState(false);

  const handleClick = () => {
    onClick();
    if (feedbackLabel) {
      setFeedback(true);
      setTimeout(() => setFeedback(false), 1500);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || feedback}
      className={`px-3.5 py-1.5 rounded transition-all text-sm ${
        feedback
          ? "bg-green-500/80 text-white"
          : "bg-white/10 hover:bg-white/20 text-white"
      } disabled:opacity-60`}
    >
      {feedback ? feedbackLabel : label}
    </button>
  );
}

function Dropdown({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-3.5 py-1.5 rounded transition-all text-sm bg-white/10 hover:bg-white/20 text-white inline-flex items-center gap-1.5"
      >
        {label}
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          className="opacity-70" aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[11rem] rounded-md bg-[#0d2b52] border border-white/15 shadow-xl py-1 z-50"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  onClick,
  disabled,
  hint,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-between gap-4 px-3 py-1.5 text-left text-sm text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <span>{children}</span>
      {hint && <span className="text-[10px] uppercase tracking-wide opacity-60">{hint}</span>}
    </button>
  );
}

function isValidProjectShape(d: unknown): boolean {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const o = d as Record<string, unknown>;
  const arrays = ["components", "nets", "netAssignments", "schematicWires"];
  for (const k of arrays) {
    if (!Array.isArray(o[k])) return false;
  }
  if (o.componentDefs !== undefined && !Array.isArray(o.componentDefs)) return false;
  const board = o.board as Record<string, unknown> | undefined;
  if (!board || typeof board !== "object" ||
      typeof board.rows !== "number" || typeof board.cols !== "number") return false;
  return true;
}

export default function ProjectToolbar({ editUuid, viewUuid, onSave, saving, lastSaved, saveError, autoSave, onToggleAutoSave }: Props) {
  const router = useRouter();
  const name = useProjectStore((s) => s.name);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const exportProject = useProjectStore((s) => s.exportProject);
  const importProject = useProjectStore((s) => s.importProject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const [saveFlash, setSaveFlash] = useState(false);
  // With auto-save on, the Save button would flip to "Saving..." every second.
  // Suppress that transient so it doesn't flicker (manual saves still flash).
  const showSaving = saving && !autoSave;
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [showSaveNotice, setShowSaveNotice] = useState(false);
  const hasShownSaveNotice = useRef(false);
  // Number of generated footprints shipped with the last netlist export, or null.
  const [footprintNotice, setFootprintNotice] = useState<number | null>(null);

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);

  useEffect(() => {
    getMe().then(setUser);
  }, []);

  // After login/register: adopt the user, and claim this project if it's still
  // unowned (so a freshly-registered user owns the project they were editing).
  const handleAuthSuccess = (u: User) => {
    setUser(u);
    setShowAuth(null);
    (async () => {
      if (editUuid) {
        try { await claimProject(editUuid); } catch { /* already owned or not claimable */ }
      }
      router.refresh();
    })();
  };

  const [logoutFlash, setLogoutFlash] = useState(false);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setLogoutFlash(true);
    setTimeout(() => setLogoutFlash(false), 1500);
    router.refresh();
  };

  // Sync nameValue when name changes externally
  useEffect(() => {
    setNameValue(name);
  }, [name]);

  // Global undo/redo keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't hijack Ctrl+Z/Y while editing text — let the field's native
      // undo work and never revert the whole project from a text field.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      // Normalize: with Shift held the browser reports e.key as "Z"/"Y", not
      // "z"/"y" — comparing against lowercase made Ctrl+Shift+Z never match.
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  const commitName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== name) {
      setProjectName(trimmed);
    }
    setEditingName(false);
  };

  const handleExport = () => {
    track("export-project");
    const data = exportProject();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportNetlist = () => {
    track("export-net");
    const s = useProjectStore.getState();
    const base = s.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const netlist = toKicadNetlist({
      name: s.name,
      components: s.components,
      componentDefs: s.componentDefs,
      nets: s.nets,
      netAssignments: s.netAssignments,
      date: new Date().toISOString(),
    });
    downloadBlob(new Blob([netlist], { type: "text/plain" }), `${base}.net`);

    // Parts with no stock KiCad footprint (e.g. custom parts with non-numeric
    // pin ids) reference a generated footprint library; ship it alongside.
    const footprints = collectGeneratedFootprints(s.components, s.componentDefs);
    if (footprints.length > 0) {
      const zip = createZip(
        footprints.map((f) => ({ name: `${FOOTPRINT_LIB_NICKNAME}.pretty/${f.name}`, content: f.content }))
      );
      downloadBlob(zip, `${FOOTPRINT_LIB_NICKNAME}.pretty.zip`);
      setFootprintNotice(footprints.length);
    }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.target?.result as string);
      } catch {
        alert("Invalid project file: not valid JSON.");
        return;
      }
      if (!isValidProjectShape(data)) {
        alert("This file doesn't look like a Stripboard Editor project.");
        return;
      }
      if (
        useProjectStore.getState().isDirty &&
        !window.confirm("Importing replaces your current project. You have unsaved changes — continue? (You can still undo with Ctrl+Z.)")
      ) {
        return;
      }
      const version = (data as { version?: number }).version ?? 1;
      const migrated = version < 2;
      if (migrated) {
        try {
          data = await migrateProjectData(data);
        } catch {
          alert("Failed to migrate imported project to the current version.");
          return;
        }
      }
      importProject(data as Parameters<typeof importProject>[0]);
      track("project-import", { migrated: migrated ? "yes" : "no" });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSave = async () => {
    if (!onSave) return;
    track("project-save");
    const ok = await onSave();
    if (ok) {
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 1500);
      if (!user && !hasShownSaveNotice.current) {
        hasShownSaveNotice.current = true;
        setShowSaveNotice(true);
      }
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    track("share-link-copy", { type: label });
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };


  const isDirty = useProjectStore((s) => s.isDirty);

  const handleExit = () => {
    if (isDirty) {
      setShowExitConfirm(true);
    } else {
      router.push("/");
    }
  };

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <>
      <div className="h-12 bg-[#113768] text-white flex items-center px-5 justify-between text-sm border-b-2 border-[var(--copper)]">
        <div className="flex items-center gap-3">
          <button
            onClick={handleExit}
            className="font-mono font-semibold tracking-wide hover:opacity-80 transition-opacity"
          >
            ← stripboard_editor
          </button>
          <span className="opacity-40">|</span>
          {editingName ? (
            <input
              autoFocus
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") { setNameValue(name); setEditingName(false); }
              }}
              className="bg-white/10 border border-white/30 rounded px-2.5 py-0.5 text-sm text-white outline-none w-52"
            />
          ) : (
            <span
              className="inline-flex items-center gap-1 opacity-80 cursor-pointer hover:opacity-100 transition-opacity"
              onClick={() => setEditingName(true)}
              title="Click to rename"
            >
              {name}
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="opacity-60"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </span>
          )}
          {saveError ? (
            <span className="text-red-300 font-medium">Save failed</span>
          ) : lastSaved ? (
            <span className="font-mono opacity-40">
              saved {lastSaved.toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 font-mono">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="px-2 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Undo (Ctrl+Z)"
          >
            ↶
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="px-2 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
          >
            ↷
          </button>
          <span className="opacity-20">|</span>
          {onSave && (
            <button
              onClick={handleSave}
              disabled={showSaving || saveFlash}
              className={`px-3.5 py-1.5 rounded transition-all text-sm ${
                saveFlash
                  ? "bg-green-500/80 text-white"
                  : saveError
                  ? "bg-red-500/80 text-white hover:bg-red-600/80"
                  : showSaving
                  ? "bg-white/10 opacity-60"
                  : "bg-white/10 hover:bg-white/20"
              }`}
              title={saveError ? "Last save failed — click to retry" : undefined}
            >
              {saveFlash ? "Saved!" : showSaving ? "Saving..." : saveError ? "Retry save" : "Save"}
            </button>
          )}
          {onToggleAutoSave && (
            <button
              onClick={onToggleAutoSave}
              className={`px-3.5 py-1.5 rounded text-sm transition-all ${
                autoSave
                  ? "bg-green-500/80 text-white"
                  : "bg-white/10 hover:bg-white/20"
              }`}
              title={autoSave ? "Auto-save is on — click to disable" : "Enable auto-save to server"}
            >
              {autoSave ? "Auto-save on" : "Auto-save"}
            </button>
          )}
          <span className="opacity-20">|</span>
          {user && editUuid && viewUuid && (
            <FeedbackButton
              onClick={() => setShowShare(!showShare)}
              label="Share"
            />
          )}
          <FeedbackButton
            onClick={() => { track("print-open", { source: "edit" }); setShowPrint(true); }}
            label="Print"
          />
          <span className="opacity-20">|</span>
          <Dropdown label="Export">
            <DropdownItem onClick={handleExport}>Raw project (.json)</DropdownItem>
            <DropdownItem onClick={handleExportNetlist}>Netlist (.net)</DropdownItem>
          </Dropdown>
          <Dropdown label="Import">
            <DropdownItem onClick={() => fileInputRef.current?.click()}>Project (.json)</DropdownItem>
            <DropdownItem disabled hint="Coming soon">Netlist (.net)</DropdownItem>
          </Dropdown>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
          <span className="opacity-20">|</span>
          {user ? (
            <>
              <span className="opacity-70 text-sm">{user.username}</span>
              <button
                onClick={handleLogout}
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
              >
                Logout
              </button>
            </>
          ) : logoutFlash ? (
            <span className="text-sm text-green-300">Logged out</span>
          ) : (
            <>
              <button
                onClick={() => setShowAuth("login")}
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
              >
                Login
              </button>
              <button
                onClick={() => setShowAuth("register")}
                className="px-3 py-1.5 rounded bg-white/20 hover:bg-white/30 transition-colors text-sm"
              >
                Register
              </button>
            </>
          )}
          <button
            onClick={() => window.dispatchEvent(new Event("toggle-shortcuts"))}
            className="px-2 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            ?
          </button>
          <ThemeToggle />
        </div>
      </div>

      {showPrint && <PrintPreview source="edit" editUuid={editUuid} viewUuid={viewUuid} onClose={() => setShowPrint(false)} />}

      {/* Share panel */}
      {showShare && editUuid && viewUuid && (
        <div className="bg-[#113768]/5 dark:bg-[#5b9bd5]/10 border-b border-[var(--copper)]/40 px-5 py-3.5 flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2 flex-1">
            <span className="font-mono text-neutral-600 dark:text-neutral-400 font-medium">Edit link:</span>
            <code className="font-sans bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded px-2.5 py-1 text-neutral-800 dark:text-neutral-200 flex-1 truncate">
              {baseUrl}/project/{editUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/project/${editUuid}`, "edit")}
              className={`font-mono px-3.5 py-1.5 rounded transition-all ${
                copied === "edit"
                  ? "bg-green-500 text-white"
                  : "bg-[#113768] text-white hover:bg-[#0d2a50]"
              }`}
            >
              {copied === "edit" ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <span className="font-mono text-neutral-600 dark:text-neutral-400 font-medium">View only link:</span>
            <code className="font-sans bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded px-2.5 py-1 text-neutral-800 dark:text-neutral-200 flex-1 truncate">
              {baseUrl}/view/{viewUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/view/${viewUuid}`, "view")}
              className={`font-mono px-3.5 py-1.5 rounded transition-all ${
                copied === "view"
                  ? "bg-green-500 text-white"
                  : "bg-[#113768] text-white hover:bg-[#0d2a50]"
              }`}
            >
              {copied === "view" ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setShowShare(false)}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-lg"
          >
            ×
          </button>
        </div>
      )}

      {/* Save notice for anonymous users */}
      {showSaveNotice && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-5 py-3 flex items-center gap-3 text-sm">
          <div className="flex-1 text-amber-800 dark:text-amber-200">
            Project saved! Bookmark this page or copy the URL to access it later. You need the exact uri to access this project again!
            <button
              onClick={() => { setShowSaveNotice(false); setShowAuth("register"); }}
              className="ml-2 text-[#113768] dark:text-[#5b9bd5] font-medium hover:underline"
            >
              Create an account
            </button>
            {" "}to keep all your projects in one place.
          </div>
          <button
            onClick={() => setShowSaveNotice(false)}
            className="text-amber-400 hover:text-amber-600 dark:text-amber-500 dark:hover:text-amber-300 text-lg flex-shrink-0"
          >
            ×
          </button>
        </div>
      )}

      {/* Netlist export shipped a generated footprint library */}
      {footprintNotice !== null && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setFootprintNotice(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[30rem] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
              Footprint library included
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              {footprintNotice} part{footprintNotice === 1 ? "" : "s"} in this design{" "}
              {footprintNotice === 1 ? "has" : "have"} no standard KiCad footprint, so{" "}
              <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
                {FOOTPRINT_LIB_NICKNAME}.pretty.zip
              </code>{" "}
              was downloaded alongside the netlist.
            </p>
            <ol className="text-sm text-neutral-600 dark:text-neutral-400 mb-5 space-y-1.5 list-decimal list-outside pl-5">
              <li>
                Unzip it to get the{" "}
                <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
                  {FOOTPRINT_LIB_NICKNAME}.pretty
                </code>{" "}
                folder.
              </li>
              <li>
                In KiCad, open{" "}
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  Preferences → Manage Footprint Libraries
                </span>
                .
              </li>
              <li>
                Add that folder with the nickname{" "}
                <code className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5">
                  {FOOTPRINT_LIB_NICKNAME}
                </code>
                .
              </li>
            </ol>
            <div className="flex justify-end">
              <button
                onClick={() => setFootprintNotice(null)}
                className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved changes confirmation */}
      {showExitConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowExitConfirm(false)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-96"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Unsaved Changes</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
              You have unsaved changes. Would you like to save before leaving?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowExitConfirm(false)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => router.push("/")}
                className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Discard & Leave
              </button>
              <button
                onClick={async () => {
                  const ok = onSave ? await onSave() : true;
                  if (ok) router.push("/");
                }}
                className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] transition-colors"
              >
                Save & Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auth modal */}
      {showAuth && (
        <AuthModal
          mode={showAuth}
          onMode={setShowAuth}
          onClose={() => setShowAuth(null)}
          onSuccess={handleAuthSuccess}
        />
      )}
    </>
  );
}
