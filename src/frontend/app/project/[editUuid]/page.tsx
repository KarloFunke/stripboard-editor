"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getProject, saveProject } from "@/lib/api";
import { track } from "@/lib/track";
import { Project } from "@/types";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import ProjectToolbar from "@/components/ProjectToolbar";
import SplitPane from "@/components/SplitPane";
import { useIsMobile } from "@/hooks/useIsMobile";
import ShortcutOverlay from "@/components/ShortcutOverlay";

export default function ProjectEditorPage() {
  const params = useParams();
  const editUuid = params.editUuid as string;
  const loadProject = useProjectStore((s) => s.loadProject);
  const isMobile = useIsMobile();
  const setProjectName = useProjectStore((s) => s.setProjectName);
  // Auto-save preference is persisted on the project, so it survives reloads and
  // is restored by loadProject below (a project saved with it on stays on).
  const autoSave = useProjectStore((s) => s.autoSave ?? false);
  const setAutoSave = useProjectStore((s) => s.setAutoSave);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewUuid, setViewUuid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState(false);
  const savingRef = useRef(false);
  const rerunRef = useRef(false);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useProjectStore.getState().isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    getProject(editUuid)
      .then((project) => {
        loadProject(project.data as unknown as Project);
        setProjectName(project.name);
        setViewUuid(project.view_uuid);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [editUuid, loadProject]);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) {
      rerunRef.current = true;
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = false;
    try {
      const store = useProjectStore.getState();
      const seq = store._editSeq;
      const data = store.exportProject();
      await saveProject(editUuid, data.name, data as unknown as Record<string, unknown>);
      if (useProjectStore.getState()._editSeq === seq) {
        useProjectStore.getState().markClean();
      }
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
      void doSave();
    }
    return ok;
  }, [editUuid]);

  const handleSave = doSave;

  // Toggling auto-save persists the flag to the server right away, so the
  // preference sticks for this project (in either direction).
  const handleToggleAutoSave = useCallback(() => {
    const next = !autoSave;
    track(next ? "autosave-on" : "autosave-off");
    setAutoSave(next);
    void doSave();
  }, [autoSave, setAutoSave, doSave]);

  // Auto-save: debounced save on store changes. Gated on !loading so the
  // persisted flag from a previously-open project can't fire against this
  // project's data before loadProject has swapped it in.
  useEffect(() => {
    if (loading || !autoSave) return;
    let timeout: ReturnType<typeof setTimeout>;
    const unsub = useProjectStore.subscribe((state) => {
      if (!state.isDirty) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => { void doSave(); }, 1000); // debounce 1s after the last edit
    });
    return () => {
      unsub();
      clearTimeout(timeout);
    };
  }, [loading, autoSave, doSave]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#fafafa] dark:bg-[#121212] text-neutral-500 dark:text-neutral-400">
        Loading project...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#fafafa] dark:bg-[#121212]">
        <div className="text-center">
          <p className="text-lg text-neutral-700 dark:text-neutral-300 mb-2">Project not found</p>
          <a href="/" className="text-[#113768] dark:text-[#5b9bd5] hover:underline text-sm">Back to home</a>
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-[#fafafa] dark:bg-[#121212]">
        <div className="bg-[#113768] text-white px-4 py-3 border-b-2 border-[var(--copper)]">
          <a href="/" className="font-mono font-semibold tracking-wide hover:opacity-80 transition-opacity text-sm">
            ← stripboard_editor
          </a>
        </div>
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-2">Desktop recommended</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              The editor is designed for desktop use. To view this project on mobile, use the view-only link.
            </p>
            {viewUuid && (
              <a
                href={`/view/${viewUuid}`}
                className="inline-block bg-[#113768] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
              >
                View Project
              </a>
            )}
            <a
              href="/"
              className="block mt-3 text-sm text-[#113768] dark:text-[#5b9bd5] hover:underline"
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
        editUuid={editUuid}
        viewUuid={viewUuid}
        onSave={handleSave}
        saving={saving}
        lastSaved={lastSaved}
        saveError={saveError}
        autoSave={autoSave}
        onToggleAutoSave={handleToggleAutoSave}
      />
      <SplitPane
        left={<SchematicEditor />}
        right={<StripboardEditor />}
      />
      <ShortcutOverlay />
    </div>
  );
}
