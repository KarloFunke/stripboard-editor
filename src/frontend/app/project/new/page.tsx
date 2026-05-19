"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { createProject } from "@/lib/api";
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
  const markClean = useProjectStore((s) => s.markClean);

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

  const handleSave = useCallback(async (): Promise<boolean> => {
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
    }
    setSaving(false);
    return ok;
  }, [editUuid, exportProject, markClean]);

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
      />
      <SplitPane
        left={<SchematicEditor />}
        right={<StripboardEditor />}
      />
      <ShortcutOverlay />
    </div>
  );
}
