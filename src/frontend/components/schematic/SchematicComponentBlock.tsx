"use client";

import { useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getBlockSize } from "./blockLayout";

const PIN_RADIUS = 5;
const PIN_SPACING = 24;
const PIN_LABEL_HEIGHT = 14;
const PADDING_X = 16;
const PADDING_TOP = 16;

interface Props {
  component: Component;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

export default function SchematicComponentBlock({
  component,
  isSelected,
  onMouseDown,
}: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);
  const togglePinNet = useProjectStore((s) => s.togglePinNet);
  const activeNetId = useProjectStore((s) => s.activeNetId);
  const activeTag = useProjectStore((s) => s.activeTag);
  const updateLabel = useProjectStore((s) => s.updateLabel);
  const updateTag = useProjectStore((s) => s.updateTag);

  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [editLabelValue, setEditLabelValue] = useState("");

  const def = resolveComponentDef(component, componentDefs);
  if (!def) return null;

  const { blockWidth, blockHeight } = getBlockSize(def);

  const getPinColor = (pinId: string): string => {
    const assignment = netAssignments.find(
      (a) => a.componentId === component.id && a.pinId === pinId
    );
    if (!assignment) return "#9ca3af";
    const net = nets.find((n) => n.id === assignment.netId);
    return net?.color ?? "#9ca3af";
  };

  const handlePinClick = (pinId: string) => {
    togglePinNet(component.id, pinId);
  };

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

  const handleTagClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeTag) {
      // Paint mode: apply active tag
      updateTag(component.id, activeTag);
    }
  };

  return (
    <g
      transform={`translate(${component.schematicPos.x}, ${component.schematicPos.y})`}
      style={{ cursor: "grab" }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {/* Body */}
      <rect
        width={blockWidth}
        height={blockHeight}
        rx={4}
        fill="white"
        stroke={isSelected ? "#113768" : "#404040"}
        strokeWidth={isSelected ? 2 : 1.5}
      />

      {/* Label above — click to edit inline */}
      {editingLabel ? (
        <foreignObject x={-10} y={-22} width={blockWidth + 20} height={20}>
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
          x={blockWidth / 2}
          y={-6}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill="#171717"
          style={{ cursor: "text" }}
          onClick={handleLabelClick}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {component.label}
        </text>
      )}

      {/* Tag below — click to apply active tag */}
      <text
        x={blockWidth / 2}
        y={blockHeight + 14}
        textAnchor="middle"
        fontSize={10}
        fill={activeTag ? "#16a34a" : "#404040"}
        style={{ cursor: activeTag ? "pointer" : "default" }}
        onClick={handleTagClick}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {component.tag || def.name}
      </text>

      {/* Pins */}
      {def.pins.map((pin) => {
        const px = PADDING_X + pin.offsetCol * PIN_SPACING;
        const py = PADDING_TOP + pin.offsetRow * PIN_SPACING;
        const color = getPinColor(pin.id);
        const isAssigned = netAssignments.some(
          (a) => a.componentId === component.id && a.pinId === pin.id
        );

        return (
          <g key={pin.id} data-pin={pin.id}>
            {/* Pin clickable area */}
            <circle
              cx={px}
              cy={py}
              r={PIN_RADIUS + 3}
              fill="transparent"
              style={{ cursor: activeNetId ? "pointer" : "default" }}
              onClick={(e) => {
                e.stopPropagation();
                handlePinClick(pin.id);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
            {/* Pin dot */}
            <circle
              cx={px}
              cy={py}
              r={PIN_RADIUS}
              fill={isAssigned ? color : "white"}
              stroke={color}
              strokeWidth={2}
              pointerEvents="none"
            />
            {/* Pin label */}
            <text
              x={px}
              y={py + PIN_RADIUS + 11}
              textAnchor="middle"
              fontSize={8}
              fill="#171717"
              pointerEvents="none"
            >
              {pin.name}
            </text>
          </g>
        );
      })}
    </g>
  );
}
