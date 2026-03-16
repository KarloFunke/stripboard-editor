"use client";

import { useRef } from "react";
import { useProjectStore } from "@/store/useProjectStore";

export default function ProjectToolbar() {
  const name = useProjectStore((s) => s.name);
  const exportProject = useProjectStore((s) => s.exportProject);
  const loadProject = useProjectStore((s) => s.loadProject);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
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
      } catch {
        alert("Invalid project file.");
      }
    };
    reader.readAsText(file);
    // Reset so same file can be re-imported
    e.target.value = "";
  };

  return (
    <div className="h-8 bg-[#113768] text-white flex items-center px-4 justify-between text-xs">
      <span className="font-semibold tracking-wide">{name}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={handleExport}
          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
        >
          Export JSON
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition-colors"
        >
          Import JSON
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleImport}
          className="hidden"
        />
      </div>
    </div>
  );
}
