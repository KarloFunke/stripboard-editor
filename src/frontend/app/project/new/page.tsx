"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { createProject } from "@/lib/api";
import { track } from "@/lib/track";
import { loadDraft, saveDraft, clearDraft, draftAge, type ProjectDraft } from "@/lib/newProjectDraft";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import ProjectToolbar from "@/components/ProjectToolbar";
import SplitPane from "@/components/SplitPane";
import { useIsMobile } from "@/hooks/useIsMobile";
import ShortcutOverlay from "@/components/ShortcutOverlay";

export default function NewProjectPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const exportProject = useProjectStore((s) => s.exportProject);
  const importProject = useProjectStore((s) => s.importProject);
  const markClean = useProjectStore((s) => s.markClean);
  const isDirty = useProjectStore((s) => s.isDirty);
  const editSeq = useProjectStore((s) => s._editSeq);
  const autoSave = useProjectStore((s) => s.autoSave ?? false);
  const setAutoSave = useProjectStore((s) => s.setAutoSave);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useProjectStore.getState().isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [editUuid, setEditUuid] = useState<string | null>(null);
  const [viewUuid, setViewUuid] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<ProjectDraft | null>(null);
  const firstEditRef = useRef(false);
  const savingRef = useRef(false);
  const rerunRef = useRef(false);

  // Offer to restore a previous unsaved design, but only over a fresh/empty
  // editor (resetProject runs before we land here on a normal "new project").
  useEffect(() => {
    const draft = loadDraft();
    if (!draft) return;
    const s = useProjectStore.getState();
    const empty =
      s.components.length === 0 && s.nets.length === 0 && s.schematicWires.length === 0 &&
      s.board.cuts.length === 0 && s.board.wires.length === 0;
    if (empty) setDraftPrompt(draft);
  }, []);

  // Track the first real edit of a fresh project (fires once, before any save),
  // and drop the restore offer since the user chose to start fresh.
  useEffect(() => {
    if (isDirty && !firstEditRef.current && !editUuid) {
      firstEditRef.current = true;
      track("project-first-edit");
      setDraftPrompt(null);
    }
  }, [isDirty, editUuid]);

  // Debounced draft to localStorage on every edit, until the project is saved
  // to the backend (after which the draft is cleared in handleSave).
  useEffect(() => {
    if (editUuid || !useProjectStore.getState().isDirty) return;
    const t = setTimeout(() => saveDraft(useProjectStore.getState().exportProject()), 800);
    return () => clearTimeout(t);
  }, [editSeq, editUuid]);

  const restoreDraft = useCallback(() => {
    if (!draftPrompt) return;
    firstEditRef.current = true; // a restore isn't a fresh first edit
    importProject(draftPrompt.project);
    setDraftPrompt(null);
    track("draft-restore");
  }, [draftPrompt, importProject]);

  const dismissDraft = useCallback(() => {
    clearDraft();
    setDraftPrompt(null);
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    // Guard against concurrent saves — without it an auto-save firing mid-create
    // could create a second project before editUuid is set. If a save is
    // requested while one is in flight, re-run once afterward so the latest
    // state (edited during the save) still gets persisted.
    if (savingRef.current) {
      rerunRef.current = true;
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = false;
    try {
      const seq = useProjectStore.getState()._editSeq;
      const projectData = exportProject();
      if (!editUuid) {
        // First save: create in DB
        const project = await createProject(
          projectData.name,
          projectData as unknown as Record<string, unknown>
        );
        setEditUuid(project.edit_uuid);
        setViewUuid(project.view_uuid);
        // Now persisted server-side — the local draft is no longer needed.
        clearDraft();
        // Replace URL without full reload so state is preserved
        window.history.replaceState(null, "", `/project/${project.edit_uuid}`);
      } else {
        // Subsequent saves: update existing
        const { saveProject } = await import("@/lib/api");
        await saveProject(editUuid, projectData.name, projectData as unknown as Record<string, unknown>);
      }
      if (useProjectStore.getState()._editSeq === seq) markClean();
      setLastSaved(new Date());
      setSaveError(false);
      ok = true;
    } catch {
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (rerunRef.current) {
      rerunRef.current = false;
      void handleSave();
    }
    return ok;
  }, [editUuid, exportProject, markClean]);

  // Toggling auto-save persists the flag right away. On an unsaved project this
  // first save is the create, so enabling auto-save also persists the project.
  const handleToggleAutoSave = useCallback(() => {
    const next = !autoSave;
    track(next ? "autosave-on" : "autosave-off");
    setAutoSave(next);
    void handleSave();
  }, [autoSave, setAutoSave, handleSave]);

  // Auto-save: debounced save on store changes (mirrors the saved-project page).
  useEffect(() => {
    if (!autoSave) return;
    let timeout: ReturnType<typeof setTimeout>;
    const unsub = useProjectStore.subscribe((state) => {
      if (!state.isDirty) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => { void handleSave(); }, 1000); // debounce 1s after the last edit
    });
    return () => {
      unsub();
      clearTimeout(timeout);
    };
  }, [autoSave, handleSave]);

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-[#fafafa] dark:bg-[#121212]">
        <div className="bg-[#113768] text-white px-4 py-3">
          <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity text-sm">
            Stripboard Editor
          </a>
        </div>
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-2">Desktop recommended</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              The editor is designed for desktop use. Please open this page on a computer to create and edit projects.
            </p>
            <a
              href="/"
              className="inline-block bg-[#113768] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
            >
              Back to home
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fafafa] dark:bg-[#121212]">
      <ProjectToolbar
        editUuid={editUuid ?? undefined}
        viewUuid={viewUuid}
        onSave={handleSave}
        saving={saving}
        lastSaved={lastSaved}
        saveError={saveError}
        autoSave={autoSave}
        onToggleAutoSave={handleToggleAutoSave}
      />
      {draftPrompt && (
        <div className="flex items-center gap-3 border-y-2 border-red-500 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-sm">
          <span className="text-red-900 dark:text-red-200">
            You have an unsaved design from {draftAge(draftPrompt.savedAt)}. Restore it?
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={restoreDraft}
              className="font-mono px-3 py-1 rounded bg-[#113768] text-white border-2 border-[#113768] hover:border-[var(--copper)] transition-colors"
            >
              Restore
            </button>
            <button
              onClick={dismissDraft}
              className="font-mono px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <SplitPane
        left={<SchematicEditor />}
        right={<StripboardEditor />}
      />
      <ShortcutOverlay />
    </div>
  );
}
