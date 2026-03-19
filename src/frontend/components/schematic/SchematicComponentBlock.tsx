"use client";

import { useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import SymbolRenderer, { getSymbolBounds } from "./SymbolRenderer";

interface Props {
  component: Component;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinMouseDown?: (componentId: string, pinId: string, e: React.MouseEvent) => void;
}

export default function SchematicComponentBlock({
  component,
  isSelected,
  onMouseDown,
  onPinMouseDown,
}: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);
  const updateLabel = useProjectStore((s) => s.updateLabel);

  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [editLabelValue, setEditLabelValue] = useState("");

  const def = resolveComponentDef(component, componentDefs);
  if (!def) return null;

  const rotation = component.schematicRotation ?? 0;
  const bounds = getSymbolBounds(def.symbol, rotation);

  // Build pin color map from net assignments
  const pinColors: Record<string, string> = {};
  for (const a of netAssignments) {
    if (a.componentId === component.id) {
      const net = nets.find((n) => n.id === a.netId);
      if (net) pinColors[a.pinId] = net.color;
    }
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    onMouseDown(e);
  };

  const handleMouseUp = () => {
    mouseDownPos.current = null;
  };

  const handleLabelClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditLabelValue(component.label);
    setEditingLabel(true);
  };

  const commitLabel = () => {
    const trimmed = editLabelValue.trim();
    if (trimmed && trimmed !== component.label) {
      updateLabel(component.id, trimmed);
    }
    setEditingLabel(false);
  };

  const handlePinMouseDown = (pinId: string, e: React.MouseEvent) => {
    onPinMouseDown?.(component.id, pinId, e);
  };

  return (
    <g
      transform={`translate(${component.schematicPos.x}, ${component.schematicPos.y})`}
      style={{ cursor: "grab" }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {/* Invisible hit area for dragging */}
      <rect
        x={bounds.minX - 5}
        y={bounds.minY - 5}
        width={bounds.width + 10}
        height={bounds.height + 10}
        fill="transparent"
      />

      {/* Label above the topmost point */}
      {editingLabel ? (
        <foreignObject
          x={-50}
          y={bounds.minY - 24}
          width={100}
          height={20}
        >
          <input
            autoFocus
            value={editLabelValue}
            onChange={(e) => setEditLabelValue(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLabel();
              if (e.key === "Escape") setEditingLabel(false);
            }}
            className="w-full bg-white border border-[#113768] rounded px-1 text-xs text-center text-neutral-900 outline-none"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </foreignObject>
      ) : (
        <text
          x={(bounds.minX + bounds.maxX) / 2}
          y={bounds.minY - 6}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill="#171717"
          style={{ cursor: "text", userSelect: "none" }}
          onClick={handleLabelClick}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {component.label}
        </text>
      )}

      {/* Symbol */}
      <SymbolRenderer
        symbolId={def.symbol}
        rotation={rotation}
        selected={isSelected}
        pinColors={pinColors}
        onPinMouseDown={handlePinMouseDown}
        showPinLabels={true}
      />
    </g>
  );
}
