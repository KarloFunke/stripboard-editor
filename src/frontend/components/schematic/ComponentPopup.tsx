"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";

const PRESET_TAGS = [
  "Capacitor", "Connector", "Crystal", "Diode",
  "IC", "LED", "Regulator", "Relay", "Resistor",
];

interface Props {
  component: Component;
  onClose: () => void;
}

export default function ComponentPopup({ component, onClose }: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);
  const updateLabel = useProjectStore((s) => s.updateLabel);
  const updateTag = useProjectStore((s) => s.updateTag);
  const updatePinName = useProjectStore((s) => s.updatePinName);
  const removeComponent = useProjectStore((s) => s.removeComponent);
  const setEditingFootprintComponent = useProjectStore((s) => s.setEditingFootprintComponent);
  const customTags = useProjectStore((s) => s.customTags);

  const def = resolveComponentDef(component, componentDefs);

  // Local editable state — committed on save or outside click
  const [label, setLabel] = useState(component.label);
  const [tag, setTag] = useState(component.tag);
  const [pinNames, setPinNames] = useState<Record<string, string>>(() => {
    if (!def) return {};
    const names: Record<string, string> = {};
    for (const pin of def.pins) {
      names[pin.id] = pin.name;
    }
    return names;
  });
  const [showTagPresets, setShowTagPresets] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const saveChanges = useCallback(() => {
    const trimmedLabel = label.trim();
    if (trimmedLabel && trimmedLabel !== component.label) {
      updateLabel(component.id, trimmedLabel);
    }
    if (tag !== component.tag) {
      updateTag(component.id, tag);
    }
    if (def) {
      for (const pin of def.pins) {
        const newName = pinNames[pin.id]?.trim();
        if (newName && newName !== pin.name) {
          updatePinName(component.id, pin.id, newName);
        }
      }
    }
  }, [label, tag, pinNames, component, def, updateLabel, updateTag, updatePinName]);

  // Outside click = save and close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        saveChanges();
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, saveChanges]);

  if (!def) return null;

  const handleSave = () => {
    saveChanges();
    onClose();
  };

  const handleCancel = () => {
    // X = close without saving
    onClose();
  };

  const handleDelete = () => {
    removeComponent(component.id);
    onClose();
  };

  const handlePinNameChange = (pinId: string, value: string) => {
    setPinNames((prev) => ({ ...prev, [pinId]: value }));
  };

  return (
    <div
      ref={containerRef}
      className="bg-white border border-neutral-300 rounded-lg shadow-lg p-3 text-sm"
      style={{ width: 230 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-neutral-900">{def.name}</span>
        <button
          onClick={handleCancel}
          className="text-neutral-400 hover:text-neutral-600 text-lg leading-none"
          title="Close without saving"
        >
          ×
        </button>
      </div>

      {/* Label */}
      <div className="mb-2">
        <label className="block text-xs text-neutral-700 mb-1">Label</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          className="w-full border border-neutral-300 rounded px-2 py-1 text-xs text-neutral-900 outline-none focus:border-blue-400"
        />
      </div>

      {/* Tag */}
      <div className="mb-3">
        <label className="block text-xs text-neutral-700 mb-1">Tag</label>
        <div className="flex gap-1">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder="e.g. Resistor, LED..."
            className="flex-1 min-w-0 border border-neutral-300 rounded px-2 py-1 text-xs text-neutral-900 outline-none focus:border-blue-400"
          />
          <button
            onClick={() => setShowTagPresets(!showTagPresets)}
            className={`px-1.5 py-1 rounded border text-xs transition-colors ${
              showTagPresets
                ? "bg-blue-50 border-blue-300 text-blue-600"
                : "bg-neutral-50 border-neutral-300 text-neutral-500 hover:bg-neutral-100"
            }`}
            title="Preset tags"
          >
            ▾
          </button>
        </div>
        {showTagPresets && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[...PRESET_TAGS, ...customTags.filter((t) => !PRESET_TAGS.includes(t))].sort().map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setTag(preset);
                  setShowTagPresets(false);
                }}
                className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                  tag === preset
                    ? "bg-blue-100 text-blue-700 border border-blue-300"
                    : "bg-neutral-100 text-neutral-600 border border-transparent hover:border-neutral-300"
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pins */}
      <div className="mb-3">
        <label className="block text-xs text-neutral-700 mb-1">Pins</label>
        <div className="flex flex-col gap-1">
          {def.pins.map((pin) => {
            const assignment = netAssignments.find(
              (a) => a.componentId === component.id && a.pinId === pin.id
            );
            const net = assignment
              ? nets.find((n) => n.id === assignment.netId)
              : null;

            return (
              <div
                key={pin.id}
                className="flex items-center gap-2 text-xs px-1 py-0.5 rounded bg-neutral-50"
              >
                <span className="text-neutral-700 w-5 flex-shrink-0">{pin.id}</span>
                <input
                  value={pinNames[pin.id] ?? pin.name}
                  onChange={(e) => handlePinNameChange(pin.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                  className="flex-1 min-w-0 bg-transparent border-b border-transparent hover:border-neutral-300 focus:border-blue-400 outline-none text-xs text-neutral-900 px-0.5"
                />
                {net ? (
                  <span className="flex items-center gap-1 flex-shrink-0">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: net.color }}
                    />
                    <span className="text-neutral-700">{net.name}</span>
                  </span>
                ) : (
                  <span className="text-neutral-400 flex-shrink-0">—</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 mb-2">
        <button
          onClick={handleSave}
          className="flex-1 bg-blue-500 text-white text-xs py-1.5 rounded hover:bg-blue-600 transition-colors"
        >
          Save
        </button>
        <button
          onClick={() => setEditingFootprintComponent(component.id)}
          className="flex-1 bg-neutral-100 text-neutral-700 text-xs py-1.5 rounded hover:bg-neutral-200 transition-colors"
        >
          Footprint
        </button>
      </div>

      {/* Delete */}
      <button
        onClick={handleDelete}
        className="w-full bg-red-50 text-red-600 text-xs py-1.5 rounded hover:bg-red-100 transition-colors"
      >
        Delete
      </button>
    </div>
  );
}
