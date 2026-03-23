"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProjectStore } from "@/store/useProjectStore";
import { getProjectView, forkProject } from "@/lib/api";
import { track } from "@/lib/track";
import { Project } from "@/types";
import SchematicEditor from "@/components/SchematicEditor";
import StripboardEditor from "@/components/StripboardEditor";
import SplitPane from "@/components/SplitPane";
import { useIsMobile } from "@/hooks/useIsMobile";
import ThemeToggle from "@/components/ThemeToggle";

export default function ProjectViewPage() {
  const params = useParams();
  const router = useRouter();
  const viewUuid = params.viewUuid as string;
  const loadProject = useProjectStore((s) => s.loadProject);
  const nets = useProjectStore((s) => s.nets);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);
  const setHighlightedNetId = useProjectStore((s) => s.setHighlightedNetId);
  const isMobile = useIsMobile();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"schematic" | "stripboard">("stripboard");

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
      track("project-fork");
      router.push(`/project/${forked.edit_uuid}`);
    } catch {
      alert("Failed to fork project.");
    }
  };

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
      <div className="flex flex-col h-dvh bg-[#fafafa] dark:bg-[#121212]">
        {/* Mobile header */}
        <div className="bg-[#113768] text-white px-4 py-2 text-sm">
          <div className="flex items-center justify-between mb-2">
            <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity text-sm">
              Home - Stripboard Editor
            </a>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-1 text-xs opacity-80 truncate">
            <span className="font-medium">{projectName}</span>
            {ownerName && <span>by {ownerName}</span>}
            <span className="opacity-60">(view only)</span>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
          <button
            onClick={() => setMobileTab("schematic")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              mobileTab === "schematic"
                ? "text-[#113768] dark:text-[#5b9bd5] border-b-2 border-[#113768] dark:border-[#5b9bd5]"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
            }`}
          >
            Schematic
          </button>
          <button
            onClick={() => setMobileTab("stripboard")}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              mobileTab === "stripboard"
                ? "text-[#113768] dark:text-[#5b9bd5] border-b-2 border-[#113768] dark:border-[#5b9bd5]"
                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
            }`}
          >
            Stripboard
          </button>
        </div>

        {/* Canvas */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === "schematic" ? (
            <SchematicEditor readOnly hideSidebar />
          ) : (
            <StripboardEditor readOnly hideSidebar />
          )}
        </div>

        {/* Net bar */}
        {nets.length > 0 && (
          <div className="border-t border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2">
            <div className="flex gap-2 flex-wrap max-h-24 overflow-y-auto">
              {nets.map((net) => {
                const isActive = highlightedNetId === net.id;
                return (
                  <button
                    key={net.id}
                    onClick={() => setHighlightedNetId(isActive ? null : net.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border-2 ${
                      isActive
                        ? "border-[#113768] dark:border-[#5b9bd5] bg-[#113768]/10 dark:bg-[#5b9bd5]/10"
                        : "border-transparent bg-neutral-50 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: net.color }}
                    />
                    <span className="text-neutral-700 dark:text-neutral-300">{net.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fafafa] dark:bg-[#121212]">
      <div className="h-12 bg-[#113768] text-white flex items-center px-5 justify-between text-sm">
        <div className="flex items-center gap-2">
          <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity">
            Home - Stripboard Editor
          </a>
          <span className="opacity-40">|</span>
          <span className="font-semibold">{projectName}</span>
          {ownerName && <span className="opacity-70">by {ownerName}</span>}
          <span className="opacity-50">(view only)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFork}
            className="px-3.5 py-1.5 rounded bg-white/10 hover:bg-white/20 transition-colors text-sm"
          >
            Fork &amp; Edit
          </button>
          <ThemeToggle />
        </div>
      </div>
      <SplitPane
        left={<SchematicEditor readOnly />}
        right={<StripboardEditor readOnly />}
      />
    </div>
  );
}
