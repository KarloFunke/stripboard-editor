"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { createProject } from "@/lib/api";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import ProjectToolbar from "@/components/ProjectToolbar";
import SplitPane from "@/components/SplitPane";

export default function NewProjectPage() {
  const router = useRouter();
  const exportProject = useProjectStore((s) => s.exportProject);

  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editUuid, setEditUuid] = useState<string | null>(null);
  const [viewUuid, setViewUuid] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      const projectData = exportProject();
      if (!editUuid) {
        // First save: create in DB
        const project = await createProject(
          projectData.name,
          projectData as unknown as Record<string, unknown>
        );
        setEditUuid(project.edit_uuid);
        setViewUuid(project.view_uuid);
        setLastSaved(new Date());
        // Replace URL without full reload so state is preserved
        window.history.replaceState(null, "", `/project/${project.edit_uuid}`);
      } else {
        // Subsequent saves: update existing
        const { saveProject } = await import("@/lib/api");
        await saveProject(editUuid, projectData.name, projectData as unknown as Record<string, unknown>);
        setLastSaved(new Date());
      }
    } catch {
      alert("Failed to save project.");
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-screen bg-[#fafafa]">
      <ProjectToolbar
        editUuid={editUuid ?? undefined}
        viewUuid={viewUuid}
        onSave={handleSave}
        saving={saving}
        lastSaved={lastSaved}
      />
      <SplitPane
        left={<SchematicEditor />}
        right={<StripboardEditor />}
      />
    </div>
  );
}
