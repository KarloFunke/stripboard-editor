"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import SymbolRenderer, { getSymbolBounds, getRotatedPinPositions } from "./SymbolRenderer";
import { getSymbolDef } from "@/data/symbolDefs";

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
  const updatePinName = useProjectStore((s) => s.updatePinName);
  const wireDrawMode = useProjectStore((s) => s.schematicWireDrawMode);

  const [editingLabel, setEditingLabel] = useState(false);
  const [editLabelValue, setEditLabelValue] = useState("");
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editPinValue, setEditPinValue] = useState("");

  const def = resolveComponentDef(component, componentDefs);
  if (!def) return null;

  const rotation = component.schematicRotation ?? 0;
  const mirrored = component.schematicMirrored ?? false;
  const symbolDef = getSymbolDef(def.symbol);
  const labelYOffset = symbolDef?.labelYOffset ?? 0;
  const bounds = getSymbolBounds(def.symbol, rotation, mirrored);

  // Build pin color map from net assignments
  const pinColors: Record<string, string> = {};
  for (const a of netAssignments) {
    if (a.componentId === component.id) {
      const net = nets.find((n) => n.id === a.netId);
      if (net) pinColors[a.pinId] = net.color;
    }
  }

  // Build custom pin name map from resolved def
  const pinNames: Record<string, string> = {};
  for (const pin of def.pins) {
    pinNames[pin.id] = pin.name;
  }

  const handleLabelClick = (e: React.MouseEvent) => {
    if (wireDrawMode) return;
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

  const handlePinLabelClick = (pinId: string, e: React.MouseEvent) => {
    if (wireDrawMode) return;
    e.stopPropagation();
    setEditPinValue(pinNames[pinId] ?? pinId);
    setEditingPinId(pinId);
  };

  const commitPinName = () => {
    if (editingPinId) {
      const trimmed = editPinValue.trim();
      if (trimmed && trimmed !== pinNames[editingPinId]) {
        updatePinName(component.id, editingPinId, trimmed);
      }
      setEditingPinId(null);
    }
  };

  const handlePinMouseDown = (pinId: string, e: React.MouseEvent) => {
    onPinMouseDown?.(component.id, pinId, e);
  };

  return (
    <g
      transform={`translate(${component.schematicPos.x}, ${component.schematicPos.y})`}
      style={{ cursor: "grab" }}
      onMouseDown={onMouseDown}
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
          y={bounds.minY - 24 - labelYOffset}
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
          y={bounds.minY - 6 - labelYOffset}
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

      {/* Inline pin name editing overlay */}
      {editingPinId && (() => {
        const pinPositions = getRotatedPinPositions(def.symbol, rotation, mirrored);
        const pinPos = pinPositions.find((p) => p.pinId === editingPinId);
        if (!pinPos) return null;
        return (
          <foreignObject
            x={pinPos.x - 30}
            y={pinPos.y - 10}
            width={60}
            height={20}
          >
            <input
              autoFocus
              value={editPinValue}
              onChange={(e) => setEditPinValue(e.target.value)}
              onBlur={commitPinName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPinName();
                if (e.key === "Escape") setEditingPinId(null);
              }}
              className="w-full bg-white border border-[#113768] rounded px-1 text-[9px] text-center text-neutral-900 outline-none"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </foreignObject>
        );
      })()}

      {/* Symbol */}
      <SymbolRenderer
        symbolId={def.symbol}
        rotation={rotation}
        mirrored={mirrored}
        selected={isSelected}
        pinColors={pinColors}
        onPinMouseDown={handlePinMouseDown}
        onPinLabelClick={editingPinId ? undefined : handlePinLabelClick}
        pinNames={pinNames}
        showPinLabels={!editingPinId}
      />
    </g>
  );
}
