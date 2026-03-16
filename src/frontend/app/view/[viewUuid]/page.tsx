"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getProjectView, forkProject } from "@/lib/api";
import { Project } from "@/types";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";

export default function ProjectViewPage() {
  const params = useParams();
  const router = useRouter();
  const viewUuid = params.viewUuid as string;
  const loadProject = useProjectStore((s) => s.loadProject);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [ownerName, setOwnerName] = useState<string | null>(null);

  useEffect(() => {
    getProjectView(viewUuid)
      .then((project) => {
        loadProject(project.data as unknown as Project);
        setProjectName(project.name);
        setOwnerName(project.owner_name);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [viewUuid, loadProject]);

  const handleFork = async () => {
    try {
      const forked = await forkProject(viewUuid);
      router.push(`/project/${forked.edit_uuid}`);
    } catch {
      alert("Failed to fork project.");
    }
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
      <div className="h-8 bg-[#113768] text-white flex items-center px-4 justify-between text-xs">
        <span className="font-semibold tracking-wide">
          {projectName}
          {ownerName && <span className="font-normal opacity-70 ml-2">by {ownerName}</span>}
          <span className="font-normal opacity-50 ml-2">(view only)</span>
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFork}
            className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
          >
            Fork &amp; Edit
          </button>
          <a
            href="/"
            className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
          >
            Home
          </a>
        </div>
      </div>
      <div className="flex flex-1 min-h-0 pointer-events-none">
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
