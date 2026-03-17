"use client";

import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getProject, getMe, login, register, logout, claimProject, type User } from "@/lib/api";
import { track } from "@/lib/track";

interface Props {
  editUuid?: string;
  viewUuid?: string | null;
  onSave?: () => void | Promise<void>;
  saving?: boolean;
  lastSaved?: Date | null;
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

export default function ProjectToolbar({ editUuid, viewUuid, onSave, saving, lastSaved }: Props) {
  const router = useRouter();
  const name = useProjectStore((s) => s.name);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const exportProject = useProjectStore((s) => s.exportProject);
  const loadProject = useProjectStore((s) => s.loadProject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const [saveFlash, setSaveFlash] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [checkingChanges, setCheckingChanges] = useState(false);
  const [showSaveNotice, setShowSaveNotice] = useState(false);
  const hasShownSaveNotice = useRef(false);

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    getMe().then(setUser);
  }, []);

  const handleAuth = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const u = showAuth === "register"
        ? await register(username, password)
        : await login(username, password);
      track(showAuth === "register" ? "account-register" : "account-login");
      setUser(u);
      setShowAuth(null);
      setUsername("");
      setPassword("");
      if (editUuid) {
        try { await claimProject(editUuid); } catch { /* already owned or not claimable */ }
      }
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Authentication failed");
    }
    setAuthLoading(false);
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  // Sync nameValue when name changes externally
  useEffect(() => {
    setNameValue(name);
  }, [name]);

  // Global undo/redo keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
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
    track("project-export");
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

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        loadProject(data);
        track("project-import");
      } catch {
        alert("Invalid project file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleSave = () => {
    if (onSave) {
      onSave();
      track("project-save");
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

  // Sort keys recursively for stable JSON comparison
  const stableStringify = (obj: unknown): string =>
    JSON.stringify(obj, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v
    );

  const handleExit = async () => {
    if (!editUuid) {
      router.push("/");
      return;
    }
    setCheckingChanges(true);
    try {
      const saved = await getProject(editUuid);
      const current = exportProject();
      // Normalize: load saved data through the same export pipeline
      // to ensure both sides have the same shape (defaults stripped, etc.)
      const savedData = saved.data as Record<string, unknown>;
      // Compare only the mutable project fields, not id/name (name compared separately)
      const fieldsToCompare = ["components", "nets", "netAssignments", "board", "customTags"];
      const pickFields = (obj: Record<string, unknown>) =>
        Object.fromEntries(fieldsToCompare.map((k) => [k, obj[k]]));
      const savedJson = stableStringify(pickFields(savedData));
      const currentJson = stableStringify(pickFields(current as unknown as Record<string, unknown>));
      if (savedJson === currentJson && saved.name === current.name) {
        router.push("/");
      } else {
        setShowExitConfirm(true);
      }
    } catch {
      // Can't reach API — assume unsaved
      setShowExitConfirm(true);
    }
    setCheckingChanges(false);
  };

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <>
      <div className="h-12 bg-[#113768] text-white flex items-center px-5 justify-between text-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={handleExit}
            disabled={checkingChanges}
            className="font-semibold tracking-wide hover:opacity-80 transition-opacity disabled:opacity-60"
          >
            {checkingChanges ? "Checking..." : "Stripboard Editor"}
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
              className="opacity-80 cursor-pointer hover:opacity-100 transition-opacity"
              onClick={() => setEditingName(true)}
              title="Click to rename"
            >
              {name}
            </span>
          )}
          {lastSaved && (
            <span className="opacity-40">
              saved {lastSaved.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
            title="Redo (Ctrl+Shift+Z)"
          >
            ↷
          </button>
          <span className="opacity-20">|</span>
          {onSave && (
            <button
              onClick={handleSave}
              disabled={saving || saveFlash}
              className={`px-3.5 py-1.5 rounded transition-all text-sm ${
                saveFlash
                  ? "bg-green-500/80 text-white"
                  : saving
                  ? "bg-white/10 opacity-60"
                  : "bg-white/10 hover:bg-white/20"
              }`}
            >
              {saveFlash ? "Saved!" : saving ? "Saving..." : "Save"}
            </button>
          )}
          {user && editUuid && viewUuid && (
            <FeedbackButton
              onClick={() => setShowShare(!showShare)}
              label="Share"
            />
          )}
          <FeedbackButton
            onClick={handleExport}
            label="Export"
            feedbackLabel="Exported!"
          />
          <FeedbackButton
            onClick={() => fileInputRef.current?.click()}
            label="Import"
          />
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
        </div>
      </div>

      {/* Share panel */}
      {showShare && editUuid && viewUuid && (
        <div className="bg-[#113768]/5 border-b border-[#113768]/20 px-5 py-3.5 flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-neutral-600 font-medium">Edit link:</span>
            <code className="bg-white border border-neutral-300 rounded px-2.5 py-1 text-neutral-800 flex-1 truncate">
              {baseUrl}/project/{editUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/project/${editUuid}`, "edit")}
              className={`px-3.5 py-1.5 rounded transition-all ${
                copied === "edit"
                  ? "bg-green-500 text-white"
                  : "bg-[#113768] text-white hover:bg-[#0d2a50]"
              }`}
            >
              {copied === "edit" ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <span className="text-neutral-600 font-medium">View only link:</span>
            <code className="bg-white border border-neutral-300 rounded px-2.5 py-1 text-neutral-800 flex-1 truncate">
              {baseUrl}/view/{viewUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/view/${viewUuid}`, "view")}
              className={`px-3.5 py-1.5 rounded transition-all ${
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
            className="text-neutral-400 hover:text-neutral-600 text-lg"
          >
            ×
          </button>
        </div>
      )}

      {/* Save notice for anonymous users */}
      {showSaveNotice && (
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 flex items-center gap-3 text-sm">
          <div className="flex-1 text-amber-800">
            Project saved! Bookmark this page or copy the URL to access it later. You need the exact uri to access this project again!
            <button
              onClick={() => { setShowSaveNotice(false); setShowAuth("register"); }}
              className="ml-2 text-[#113768] font-medium hover:underline"
            >
              Create an account
            </button>
            {" "}to keep all your projects in one place.
          </div>
          <button
            onClick={() => setShowSaveNotice(false)}
            className="text-amber-400 hover:text-amber-600 text-lg flex-shrink-0"
          >
            ×
          </button>
        </div>
      )}

      {/* Unsaved changes confirmation */}
      {showExitConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowExitConfirm(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-6 w-96"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">Unsaved Changes</h2>
            <p className="text-sm text-neutral-600 mb-5">
              You have unsaved changes. Would you like to save before leaving?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowExitConfirm(false)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => router.push("/")}
                className="px-4 py-2 text-sm rounded bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Discard & Leave
              </button>
              <button
                onClick={async () => {
                  if (onSave) {
                    await onSave();
                  }
                  router.push("/");
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
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowAuth(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-6 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">
              {showAuth === "login" ? "Login" : "Register"}
            </h2>
            <form onSubmit={handleAuth} className="flex flex-col gap-3">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="border border-neutral-300 rounded px-3 py-2 text-sm text-neutral-900 outline-none focus:border-[#113768]"
                autoFocus
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="border border-neutral-300 rounded px-3 py-2 text-sm text-neutral-900 outline-none focus:border-[#113768]"
              />
              {authError && (
                <p className="text-xs text-red-500">{authError}</p>
              )}
              <button
                type="submit"
                disabled={authLoading}
                className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
              >
                {authLoading
                  ? (showAuth === "login" ? "Logging in..." : "Registering...")
                  : (showAuth === "login" ? "Login" : "Register")}
              </button>
              <p className="text-xs text-neutral-500 text-center">
                {showAuth === "login" ? (
                  <>No account? <button type="button" onClick={() => { setShowAuth("register"); setAuthError(null); }} className="text-[#113768] hover:underline">Register</button></>
                ) : (
                  <>Have an account? <button type="button" onClick={() => { setShowAuth("login"); setAuthError(null); }} className="text-[#113768] hover:underline">Login</button></>
                )}
              </p>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
