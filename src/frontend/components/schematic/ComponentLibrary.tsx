"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ComponentDef } from "@/types";
import { COMPONENT_GROUPS, DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { getSymbolDef } from "@/data/symbolDefs";
import { getSymbolBounds } from "./SymbolRenderer";
import CustomComponentEditor from "./CustomComponentEditor";

function SymbolThumbnail({ def }: { def: ComponentDef }) {
  const symbolDef = getSymbolDef(def.symbol);
  if (!symbolDef) return null;

  const bounds = getSymbolBounds(def.symbol, 0);
  const pad = 6;
  const scale = 0.4;
  const w = bounds.width * scale + pad * 2;
  const h = bounds.height * scale + pad * 2;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  return (
    <svg width={Math.max(w, 24)} height={Math.max(h, 24)} className="flex-shrink-0">
      <g transform={`translate(${Math.max(w, 24) / 2}, ${Math.max(h, 24) / 2}) scale(${scale}) translate(${-cx}, ${-cy})`}>
        {symbolDef.bodyPaths.map((path, i) => (
          <path
            key={`b-${i}`}
            d={path.d}
            fill={path.fill === "currentColor" ? "var(--symbol-stroke)" : (path.fill ?? "none")}
            stroke={path.stroke ?? "var(--symbol-stroke)"}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {symbolDef.pins.map((pin) => (
          <circle
            key={pin.pinId}
            cx={pin.stubEnd.x}
            cy={pin.stubEnd.y}
            r={2.5}
            fill="var(--hole-fill)"
            stroke="var(--pin-text)"
            strokeWidth={1}
          />
        ))}
        {symbolDef.extraElements?.map((el, i) => {
          if (el.type === "line") {
            return (
              <line
                key={`e-${i}`}
                x1={el.props.x1 as number} y1={el.props.y1 as number}
                x2={el.props.x2 as number} y2={el.props.y2 as number}
                stroke="var(--symbol-stroke)" strokeWidth={1} strokeLinecap="round"
              />
            );
          }
          if (el.type === "circle") {
            return (
              <circle
                key={`e-${i}`}
                cx={el.props.cx as number} cy={el.props.cy as number}
                r={el.props.r as number}
                fill="none" stroke="var(--symbol-stroke)" strokeWidth={1}
              />
            );
          }
          return null;
        })}
      </g>
    </svg>
  );
}

export default function ComponentLibrary() {
  const addComponent = useProjectStore((s) => s.addComponent);
  const addComponentDef = useProjectStore((s) => s.addComponentDef);
  const removeComponentDef = useProjectStore((s) => s.removeComponentDef);
  const componentDefs = useProjectStore((s) => s.componentDefs);

  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set([COMPONENT_GROUPS[0].label])
  );

  // Custom components = defs not in DEFAULT_COMPONENTS
  const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
  const customDefs = componentDefs.filter((d) => !defaultIds.has(d.id));

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const handleAdd = (defId: string) => {
    addComponent(defId, { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 });
  };

  const handleDragStart = (e: React.DragEvent, defId: string) => {
    e.dataTransfer.setData("application/schematic-component", defId);
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleCreateCustom = (def: ComponentDef) => {
    addComponentDef(def);
    setShowCustomEditor(false);
  };

  return (
    <div className="flex flex-col border-b border-neutral-200 dark:border-neutral-700">
      <div className="px-3.5 py-2.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
        Components
      </div>
      <div className="flex flex-col max-h-96 overflow-y-auto">
        {COMPONENT_GROUPS.map((group) => {
          const isOpen = openGroups.has(group.label);
          return (
            <div key={group.label}>
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                <span className="text-xs">{isOpen ? "▼" : "▶"}</span>
                {group.label}
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto text-xs">{group.components.length}</span>
              </button>
              {isOpen && (
                <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5">
                  {group.components.map((def) => (
                    <button
                      key={def.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, def.id)}
                      onClick={() => handleAdd(def.id)}
                      className="flex flex-col items-center gap-1 px-2 py-1.5 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
                      title={def.name}
                    >
                      <SymbolThumbnail def={def} />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight text-center max-w-[72px]">
                        {def.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Custom components section */}
        {customDefs.length > 0 && (
          <div>
            <button
              onClick={() => toggleGroup("Custom")}
              className="w-full flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <span className="text-xs">{openGroups.has("Custom") ? "▼" : "▶"}</span>
              Custom
              <span className="text-neutral-400 dark:text-neutral-500 ml-auto text-xs">{customDefs.length}</span>
            </button>
            {openGroups.has("Custom") && (
              <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5">
                {customDefs.map((def) => (
                  <div key={def.id} className="relative group">
                    <button
                      draggable
                      onDragStart={(e) => handleDragStart(e, def.id)}
                      onClick={() => handleAdd(def.id)}
                      className="flex flex-col items-center gap-1 px-2 py-1.5 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
                      title={def.name}
                    >
                      <SymbolThumbnail def={def} />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight text-center max-w-[72px]">
                        {def.name}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeComponentDef(def.id);
                      }}
                      className="absolute -top-1 -right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-red-400 text-white text-[9px] leading-none"
                      title="Remove custom component"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create custom button */}
      <div className="px-2.5 py-2 border-t border-neutral-200 dark:border-neutral-700">
        <button
          onClick={() => setShowCustomEditor(true)}
          className="w-full text-xs py-1.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          + Create Custom Component
        </button>
      </div>

      {showCustomEditor && (
        <CustomComponentEditor
          onSave={handleCreateCustom}
          onClose={() => setShowCustomEditor(false)}
        />
      )}
    </div>
  );
}
