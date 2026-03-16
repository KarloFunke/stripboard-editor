"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getProject, saveProject } from "@/lib/api";
import { Project } from "@/types";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import ProjectToolbar from "@/components/ProjectToolbar";

export default function ProjectEditorPage() {
  const params = useParams();
  const editUuid = params.editUuid as string;
  const loadProject = useProjectStore((s) => s.loadProject);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const exportProject = useProjectStore((s) => s.exportProject);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewUuid, setViewUuid] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  useEffect(() => {
    getProject(editUuid)
      .then((project) => {
        loadProject(project.data as unknown as Project);
        // API-level name takes precedence
        setProjectName(project.name);
        setViewUuid(project.view_uuid);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [editUuid, loadProject]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const projectData = exportProject();
      await saveProject(editUuid, projectData.name, projectData as unknown as Record<string, unknown>);
      setLastSaved(new Date());
    } catch {
      alert("Failed to save project.");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#fafafa] text-neutral-500">
        Loading project...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#fafafa]">
        <div className="text-center">
          <p className="text-lg text-neutral-700 mb-2">Project not found</p>
          <a href="/" className="text-[#113768] hover:underline text-sm">Back to home</a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fafafa]">
      <ProjectToolbar
        editUuid={editUuid}
        viewUuid={viewUuid}
        onSave={handleSave}
        saving={saving}
        lastSaved={lastSaved}
      />
      <div className="flex flex-1 min-h-0">
        <div className="w-1/2 border-r-2 border-[#113768]/20">
          <SchematicEditor />
        </div>
        <div className="w-1/2">
          <StripboardEditor />
        </div>
      </div>
    </div>
  );
}
