"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";

export default function NetPanel({ readOnly = false }: { readOnly?: boolean }) {
  const nets = useProjectStore((s) => s.nets);
  const updateNet = useProjectStore((s) => s.updateNet);
  const removeNet = useProjectStore((s) => s.removeNet);
  const highlightedNetId = useProjectStore((s) => s.highlightedNetId);
  const setHighlightedNetId = useProjectStore((s) => s.setHighlightedNetId);

  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const startEditing = (netId: string, currentName: string) => {
    setEditingNetId(netId);
    setEditName(currentName);
  };

  const commitEdit = () => {
    if (editingNetId && editName.trim()) {
      updateNet(editingNetId, { name: editName.trim() });
    }
    setEditingNetId(null);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3.5 py-2.5 text-xs font-semibold text-neutral-500 uppercase tracking-wide">
        Nets
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 flex-1 overflow-y-auto">
        {nets.length === 0 && (
          <div className="text-xs text-neutral-400 px-2.5 py-2 italic">
            Draw wires between pins to create nets
          </div>
        )}
        {nets.map((net) => {
          const isEditing = editingNetId === net.id;
          const isHighlighted = highlightedNetId === net.id;
          return (
            <div
              key={net.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-sm text-neutral-900 cursor-pointer transition-colors ${
                isHighlighted
                  ? "bg-[#113768]/10 ring-1 ring-[#113768]/30"
                  : "hover:bg-neutral-100"
              }`}
              onClick={() =>
                setHighlightedNetId(isHighlighted ? null : net.id)
              }
            >
              {readOnly ? (
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full border border-neutral-300 flex-shrink-0"
                  style={{ backgroundColor: net.color }}
                />
              ) : (
                <label
                  className="flex-shrink-0 cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="color"
                    value={net.color}
                    onChange={(e) => updateNet(net.id, { color: e.target.value })}
                    className="sr-only"
                  />
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border border-neutral-300"
                    style={{ backgroundColor: net.color }}
                  />
                </label>
              )}

              {isEditing && !readOnly ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    if (e.key === "Escape") setEditingNetId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 border border-blue-400 rounded px-1.5 py-0.5 text-sm text-neutral-900 outline-none"
                />
              ) : (
                <span
                  className="flex-1 truncate"
                  onDoubleClick={(e) => {
                    if (readOnly) return;
                    e.stopPropagation();
                    startEditing(net.id, net.name);
                  }}
                >
                  {net.name}
                </span>
              )}

              {!readOnly && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNet(net.id);
                  }}
                  className="text-neutral-400 hover:text-red-500 text-sm flex-shrink-0"
                  title="Delete net"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
