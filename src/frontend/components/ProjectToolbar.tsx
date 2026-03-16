"use client";

import { useRef, useState, useEffect } from "react";
import { useProjectStore } from "@/store/useProjectStore";

interface Props {
  editUuid?: string;
  viewUuid?: string | null;
  onSave?: () => void;
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
      className={`px-3 py-1 rounded transition-all text-xs ${
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
  const name = useProjectStore((s) => s.name);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const exportProject = useProjectStore((s) => s.exportProject);
  const loadProject = useProjectStore((s) => s.loadProject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(name);
  const [saveFlash, setSaveFlash] = useState(false);

  // Sync nameValue when name changes externally
  useEffect(() => {
    setNameValue(name);
  }, [name]);

  const commitName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== name) {
      setProjectName(trimmed);
    }
    setEditingName(false);
  };

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
    e.target.value = "";
  };

  const handleSave = () => {
    if (onSave) {
      onSave();
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 1500);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <>
      <div className="h-11 bg-[#113768] text-white flex items-center px-4 justify-between text-xs">
        <div className="flex items-center gap-3">
          <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity">
            Stripboard Editor
          </a>
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
              className="bg-white/10 border border-white/30 rounded px-2 py-0 text-xs text-white outline-none w-48"
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
          {onSave && (
            <button
              onClick={handleSave}
              disabled={saving || saveFlash}
              className={`px-3 py-1 rounded transition-all text-xs ${
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
          {editUuid && viewUuid && (
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
        </div>
      </div>

      {/* Share panel */}
      {showShare && editUuid && viewUuid && (
        <div className="bg-[#113768]/5 border-b border-[#113768]/20 px-4 py-3 flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-neutral-600 font-medium">Edit link:</span>
            <code className="bg-white border border-neutral-300 rounded px-2 py-0.5 text-neutral-800 flex-1 truncate">
              {baseUrl}/project/{editUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/project/${editUuid}`, "edit")}
              className={`px-3 py-1 rounded transition-all ${
                copied === "edit"
                  ? "bg-green-500 text-white"
                  : "bg-[#113768] text-white hover:bg-[#0d2a50]"
              }`}
            >
              {copied === "edit" ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <span className="text-neutral-600 font-medium">View link:</span>
            <code className="bg-white border border-neutral-300 rounded px-2 py-0.5 text-neutral-800 flex-1 truncate">
              {baseUrl}/view/{viewUuid}
            </code>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/view/${viewUuid}`, "view")}
              className={`px-3 py-1 rounded transition-all ${
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
            className="text-neutral-400 hover:text-neutral-600"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
