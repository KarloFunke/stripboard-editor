"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import ComponentLibrary from "./schematic/ComponentLibrary";
import NetPanel from "./schematic/NetPanel";
import SchematicCanvas from "./schematic/SchematicCanvas";
import FootprintEditor from "./schematic/FootprintEditor";

const PRESET_TAGS = [
  "Capacitor", "Connector", "Crystal", "Diode",
  "IC", "LED", "Regulator", "Relay", "Resistor",
];

export default function SchematicEditor() {
  const editingFootprintComponentId = useProjectStore((s) => s.editingFootprintComponentId);
  const showNetLines = useProjectStore((s) => s.showNetLines);
  const activeTag = useProjectStore((s) => s.activeTag);
  const customTags = useProjectStore((s) => s.customTags);
  const setShowNetLines = useProjectStore((s) => s.setShowNetLines);
  const setActiveTag = useProjectStore((s) => s.setActiveTag);
  const addCustomTag = useProjectStore((s) => s.addCustomTag);
  const removeCustomTag = useProjectStore((s) => s.removeCustomTag);

  const [customTagInput, setCustomTagInput] = useState("");

  const handleAddCustomTag = () => {
    const tag = customTagInput.trim();
    if (!tag) return;
    addCustomTag(tag);
    setActiveTag(tag);
    setCustomTagInput("");
  };

  // Merge preset + custom, sorted. Custom tags that duplicate presets are filtered.
  const allTags = [
    ...PRESET_TAGS,
    ...customTags.filter((t) => !PRESET_TAGS.includes(t)),
  ].sort();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-neutral-300 bg-white px-4 h-10 font-semibold text-sm text-[#113768] flex items-center justify-between">
        <span>Schematic / Net Editor</span>
        <div className="flex items-center gap-3 text-xs font-normal">
{null}
          <label className="flex items-center gap-1 text-neutral-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showNetLines}
              onChange={(e) => setShowNetLines(e.target.checked)}
              className="rounded"
            />
            Lines
          </label>
        </div>
      </div>

      {/* Tag selector bar */}
      <div className="border-b border-neutral-200 bg-white/70 px-4 py-1 flex items-center gap-1 flex-wrap">
        <span className="text-[10px] text-neutral-400 uppercase tracking-wide mr-1">Tags</span>
        {allTags.map((tag) => {
          const isCustom = customTags.includes(tag);
          return (
            <span key={tag} className="relative group">
              <button
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                  activeTag === tag
                    ? "bg-green-100 text-green-700 border border-green-400"
                    : "bg-white text-neutral-600 border border-neutral-300 hover:border-neutral-400"
                }`}
              >
                {tag}
              </button>
              {isCustom && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCustomTag(tag);
                  }}
                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-400 text-white text-[8px] leading-none"
                  title="Remove custom tag"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        <div className="flex items-center gap-0.5">
          <input
            value={customTagInput}
            onChange={(e) => setCustomTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddCustomTag(); }}
            placeholder="Custom..."
            className="border border-neutral-300 rounded px-2 py-0.5 text-[11px] text-neutral-900 outline-none focus:border-blue-400 w-20"
          />
          <button
            onClick={handleAddCustomTag}
            disabled={!customTagInput.trim()}
            className="text-[11px] px-1.5 py-0.5 bg-neutral-200 text-neutral-600 rounded hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            +
          </button>
        </div>
        {activeTag && (
          <button
            onClick={() => setActiveTag(null)}
            className="text-[11px] text-neutral-400 hover:text-neutral-600 px-1"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-48 flex-shrink-0 border-r border-neutral-200 flex flex-col overflow-hidden">
          <ComponentLibrary />
          <NetPanel />
        </div>
        <div className="flex-1 min-w-0">
          <SchematicCanvas />
        </div>
      </div>
      {editingFootprintComponentId && <FootprintEditor />}
    </div>
  );
}
