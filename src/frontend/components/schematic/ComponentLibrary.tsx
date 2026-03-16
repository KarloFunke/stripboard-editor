"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ComponentDef } from "@/types";
import { COMPONENT_GROUPS } from "@/data/defaultComponents";

const THUMB_HOLE = 6;    // spacing between holes in thumbnail
const THUMB_PAD = 4;     // padding around thumbnail
const THUMB_PIN_R = 2;   // pin dot radius
const THUMB_BODY_SIZE = 5; // body cell square size

function FootprintThumbnail({ def }: { def: ComponentDef }) {
  const allRows = def.pins.map((p) => p.offsetRow);
  const allCols = def.pins.map((p) => p.offsetCol);
  if (def.bodyCells) {
    allRows.push(...def.bodyCells.map((c) => c.row));
    allCols.push(...def.bodyCells.map((c) => c.col));
  }
  const maxRow = Math.max(...allRows, 0);
  const maxCol = Math.max(...allCols, 0);

  const w = maxCol * THUMB_HOLE + THUMB_PAD * 2;
  const h = maxRow * THUMB_HOLE + THUMB_PAD * 2;

  return (
    <svg width={w} height={h} className="flex-shrink-0">
      {/* Body cells */}
      {def.bodyCells?.map((cell, i) => (
        <rect
          key={`b-${i}`}
          x={THUMB_PAD + cell.col * THUMB_HOLE - THUMB_BODY_SIZE / 2}
          y={THUMB_PAD + cell.row * THUMB_HOLE - THUMB_BODY_SIZE / 2}
          width={THUMB_BODY_SIZE}
          height={THUMB_BODY_SIZE}
          rx={1}
          fill="#d4d4d4"
        />
      ))}
      {/* Pins */}
      {def.pins.map((pin) => (
        <circle
          key={pin.id}
          cx={THUMB_PAD + pin.offsetCol * THUMB_HOLE}
          cy={THUMB_PAD + pin.offsetRow * THUMB_HOLE}
          r={THUMB_PIN_R}
          fill="#404040"
        />
      ))}
    </svg>
  );
}

export default function ComponentLibrary() {
  const addComponent = useProjectStore((s) => s.addComponent);

  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set([COMPONENT_GROUPS[0].label])
  );

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

  return (
    <div className="flex flex-col border-b border-neutral-200">
      <div className="px-3 py-2 text-xs font-semibold text-neutral-500 uppercase tracking-wide">
        Components
      </div>
      <div className="flex flex-col max-h-80 overflow-y-auto">
        {COMPONENT_GROUPS.map((group) => {
          const isOpen = openGroups.has(group.label);
          return (
            <div key={group.label}>
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center gap-1 px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
              >
                <span className="text-[10px]">{isOpen ? "▼" : "▶"}</span>
                {group.label}
                <span className="text-neutral-400 ml-auto">{group.components.length}</span>
              </button>
              {isOpen && (
                <div className="flex flex-wrap gap-1 px-2 pb-2">
                  {group.components.map((def) => (
                    <button
                      key={def.id}
                      onClick={() => handleAdd(def.id)}
                      className="flex flex-col items-center gap-0.5 px-1.5 py-1 rounded border border-transparent hover:border-neutral-300 hover:bg-neutral-50 active:bg-neutral-100 transition-colors"
                      title={def.name}
                    >
                      <FootprintThumbnail def={def} />
                      <span className="text-[10px] text-neutral-500 leading-tight">
                        {def.name.replace("Inline ", "").replace("Terminal ", "")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
