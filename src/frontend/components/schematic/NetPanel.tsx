"use client";

import { useState } from "react";
import { useProjectStore, AUTO_NET_ID } from "@/store/useProjectStore";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#3b82f6", "#8b5cf6", "#ec4899", "#06b6d4",
];

export default function NetPanel() {
  const nets = useProjectStore((s) => s.nets);
  const activeNetId = useProjectStore((s) => s.activeNetId);
  const addNet = useProjectStore((s) => s.addNet);
  const updateNet = useProjectStore((s) => s.updateNet);
  const removeNet = useProjectStore((s) => s.removeNet);
  const setActiveNet = useProjectStore((s) => s.setActiveNet);

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [editingNetId, setEditingNetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    addNet(name, newColor);
    setNewName("");
    const idx = PRESET_COLORS.indexOf(newColor);
    setNewColor(PRESET_COLORS[(idx + 1) % PRESET_COLORS.length]);
  };

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

  const isAutoNew = activeNetId === AUTO_NET_ID;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2 text-xs font-semibold text-neutral-500 uppercase tracking-wide">
        Nets
      </div>

      <div className="flex flex-col gap-0.5 px-2 flex-1 overflow-y-auto">
        {/* Auto New pseudo-net */}
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm cursor-pointer transition-colors ${
            isAutoNew
              ? "bg-[#113768]/10 ring-1 ring-[#113768]/30 text-[#113768]"
              : "text-neutral-600 hover:bg-neutral-100"
          }`}
          onClick={() => setActiveNet(isAutoNew ? null : AUTO_NET_ID)}
        >
          <span className="inline-flex items-center justify-center h-3 w-3 rounded-full flex-shrink-0 border border-dashed border-[#113768]/50 bg-[#113768]/5 text-[8px] font-bold text-[#113768]/60 leading-none">
            +
          </span>
          <span className="flex-1 text-xs italic">Auto New</span>
        </div>

        {/* Real nets */}
        {nets.map((net) => {
          const isEditing = editingNetId === net.id;
          return (
            <div
              key={net.id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-sm text-neutral-900 cursor-pointer transition-colors ${
                activeNetId === net.id
                  ? "bg-[#113768]/10 ring-1 ring-[#113768]/30"
                  : "hover:bg-neutral-100"
              }`}
              onClick={() =>
                setActiveNet(activeNetId === net.id ? null : net.id)
              }
            >
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
                  className="inline-block h-3 w-3 rounded-full border border-neutral-300"
                  style={{ backgroundColor: net.color }}
                />
              </label>

              {isEditing ? (
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
                  className="flex-1 min-w-0 border border-blue-400 rounded px-1 py-0 text-xs text-neutral-900 outline-none"
                />
              ) : (
                <span
                  className="flex-1 truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startEditing(net.id, net.name);
                  }}
                >
                  {net.name}
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeNetId === net.id) setActiveNet(null);
                  removeNet(net.id);
                }}
                className="text-neutral-400 hover:text-red-500 text-xs flex-shrink-0"
                title="Delete net"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {/* Add net form */}
      <div className="border-t border-neutral-200 p-2 flex flex-col gap-1.5">
        <div className="flex gap-1">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="Net name..."
            className="flex-1 min-w-0 border border-neutral-300 rounded px-2 py-1 text-xs text-neutral-900 outline-none focus:border-blue-400"
          />
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="w-7 h-7 p-0 border border-neutral-300 rounded cursor-pointer"
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={!newName.trim()}
          className="w-full bg-[#113768] text-white text-xs py-1 rounded hover:bg-[#0d2a50] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Add Net
        </button>
      </div>
    </div>
  );
}
