"use client";

import { useState, useRef } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import SymbolRenderer, { getSymbolBounds, getRotatedPinPositions } from "./SymbolRenderer";
import { getSymbolDef } from "@/data/symbolDefs";
import { snapToGrid } from "@/utils/schematicConstants";

interface Props {
  component: Component;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinMouseDown?: (componentId: string, pinId: string, e: React.MouseEvent) => void;
  getSVGPoint?: (e: React.MouseEvent) => { x: number; y: number };
  readOnly?: boolean;
}

export default function SchematicComponentBlock({
  component,
  isSelected,
  onMouseDown,
  onPinMouseDown,
  getSVGPoint,
  readOnly = false,
}: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const netAssignments = useProjectStore((s) => s.netAssignments);
  const nets = useProjectStore((s) => s.nets);
  const updateLabel = useProjectStore((s) => s.updateLabel);
  const updateComponentValue = useProjectStore((s) => s.updateComponentValue);
  const transact = useProjectStore((s) => s.transact);
  const updatePinName = useProjectStore((s) => s.updatePinName);
  const updateLabelOffset = useProjectStore((s) => s.updateLabelOffset);
  const updatePinLabelOffset = useProjectStore((s) => s.updatePinLabelOffset);
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const wireDrawMode = useProjectStore((s) => s.schematicWireDrawMode);

  const [editingLabel, setEditingLabel] = useState(false);
  const [editLabelValue, setEditLabelValue] = useState("");
  const [editValueValue, setEditValueValue] = useState("");
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editPinValue, setEditPinValue] = useState("");
  const [draggingLabel, setDraggingLabel] = useState(false);
  const [didDragLabel, setDidDragLabel] = useState(false);
  const pinLabelSnapshotPushed = useRef(false);
  const labelSnapshotPushed = useRef(false);

  const def = resolveComponentDef(component, componentDefs);
  if (!def) return null;
  const allowsValue = def.hasValue ?? false;

  const rotation = component.schematicRotation ?? 0;
  const mirrored = component.schematicMirrored ?? false;
  const symbolDef = getSymbolDef(def.symbol);
  const symbolLabelYOffset = symbolDef?.labelYOffset ?? 0;
  const bounds = getSymbolBounds(def.symbol, rotation, mirrored);

  // Label position: default above component, offset by user drag
  const defaultLabelX = (bounds.minX + bounds.maxX) / 2;
  const defaultLabelY = bounds.minY - 6 - symbolLabelYOffset;
  const labelOff = component.labelOffset ?? { x: 0, y: 0 };
  const labelX = defaultLabelX + labelOff.x;
  const labelY = defaultLabelY + labelOff.y;
  const hasCustomOffset = labelOff.x !== 0 || labelOff.y !== 0;

  // Build pin color map
  const pinColors: Record<string, string> = {};
  for (const a of netAssignments) {
    if (a.componentId === component.id) {
      const net = nets.find((n) => n.id === a.netId);
      if (net) pinColors[a.pinId] = net.color;
    }
  }

  const pinNames: Record<string, string> = {};
  for (const pin of def.pins) {
    pinNames[pin.id] = pin.name;
  }

  const handleLabelClick = (e: React.MouseEvent) => {
    if (readOnly || wireDrawMode || didDragLabel) {
      setDidDragLabel(false);
      return;
    }
    e.stopPropagation();
    setEditLabelValue(component.label);
    setEditValueValue(component.value ?? "");
    setEditingLabel(true);
  };

  const commitLabel = () => {
    const trimmedLabel = editLabelValue.trim();
    const trimmedValue = editValueValue.trim();
    const labelChanged = !!trimmedLabel && trimmedLabel !== component.label;
    const valueChanged = allowsValue && trimmedValue !== (component.value ?? "");
    if (labelChanged || valueChanged) {
      transact(() => {
        if (labelChanged) updateLabel(component.id, trimmedLabel);
        if (valueChanged) updateComponentValue(component.id, trimmedValue);
      });
    }
    setEditingLabel(false);
  };

  const handleLabelDragStart = (e: React.MouseEvent) => {
    if (readOnly || wireDrawMode || editingLabel) return;
    e.stopPropagation();
    e.preventDefault();
    // Defer the snapshot until the label actually moves — a click on the
    // label (e.g. to rename) must not push a no-op entry / wipe redo.
    labelSnapshotPushed.current = false;
    setDraggingLabel(true);
    setDidDragLabel(false);

    const handleMove = (me: MouseEvent) => {
      setDidDragLabel(true);
      if (!getSVGPoint) return;
      const svgPt = getSVGPoint(me as unknown as React.MouseEvent);
      const newOffX = svgPt.x - component.schematicPos.x - defaultLabelX;
      const newOffY = svgPt.y - component.schematicPos.y - defaultLabelY;
      if (!labelSnapshotPushed.current) {
        pushSnapshot();
        labelSnapshotPushed.current = true;
      }
      updateLabelOffset(component.id, { x: newOffX, y: newOffY });
    };

    const handleUp = () => {
      setDraggingLabel(false);
      labelSnapshotPushed.current = false;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handlePinLabelClick = (pinId: string, e: React.MouseEvent) => {
    if (readOnly || wireDrawMode) return;
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
      style={{ cursor: "grab", opacity: component.boardExcluded ? 0.45 : 1 }}
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

      {/* Leader line from component center to label (when label is offset) */}
      {hasCustomOffset && !editingLabel && (
        <line
          x1={0} y1={0}
          x2={labelX} y2={labelY}
          stroke="var(--hole-stroke)"
          strokeWidth={0.8}
          strokeDasharray="2 2"
          pointerEvents="none"
        />
      )}

      {/* Label */}
      {!editingLabel && (
        <text
          x={labelX}
          y={labelY}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill="var(--component-text)"
          style={{ cursor: "grab", userSelect: "none" }}
          onClick={handleLabelClick}
          onMouseDown={handleLabelDragStart}
        >
          <tspan x={labelX}>{component.label}</tspan>
          {allowsValue && component.value && (
            <tspan x={labelX} dy="1.2em" fontWeight={400} fillOpacity={0.7}>
              {component.value}
            </tspan>
          )}
        </text>
      )}

      {/* Symbol */}
      <SymbolRenderer
        symbolId={def.symbol}
        rotation={rotation}
        mirrored={mirrored}
        selected={isSelected}
        pinColors={pinColors}
        onPinMouseDown={handlePinMouseDown}
        onPinLabelClick={readOnly || editingPinId ? undefined : handlePinLabelClick}
        pinNames={pinNames}
        pinLabelOffsets={component.pinLabelOffsets ?? {}}
        onPinLabelDrag={readOnly ? undefined : (pinId, offset) => {
          if (!pinLabelSnapshotPushed.current) {
            pushSnapshot();
            pinLabelSnapshotPushed.current = true;
          }
          updatePinLabelOffset(component.id, pinId, offset);
        }}
        onPinLabelDragEnd={readOnly ? undefined : () => { pinLabelSnapshotPushed.current = false; }}
        showPinLabels={!editingPinId}
      />

      {/* Editing overlays render after the symbol so they stay on top of it.
          Below it the symbol swallows the click, selecting the component and
          blurring the field shut before you can type in it. */}
      {editingLabel && (
        <foreignObject
          x={labelX - 55}
          y={labelY - 16}
          width={110}
          height={46}
        >
          <div
            className="flex flex-col gap-0.5"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitLabel();
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={editLabelValue}
              onChange={(e) => setEditLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                if (e.key === "Escape") setEditingLabel(false);
              }}
              placeholder="Ref"
              className="w-full bg-white dark:bg-neutral-800 border border-[#113768] dark:border-[#5b9bd5] rounded px-1 text-xs text-center text-neutral-900 dark:text-neutral-100 outline-none"
            />
            {allowsValue && (
              <input
                value={editValueValue}
                onChange={(e) => setEditValueValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitLabel();
                  if (e.key === "Escape") setEditingLabel(false);
                }}
                placeholder="Value"
                className="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded px-1 text-[10px] text-center text-neutral-700 dark:text-neutral-300 outline-none"
              />
            )}
          </div>
        </foreignObject>
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
              className="w-full bg-white dark:bg-neutral-800 border border-[#113768] dark:border-[#5b9bd5] rounded px-1 text-[9px] text-center text-neutral-900 dark:text-neutral-100 outline-none"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </foreignObject>
        );
      })()}
    </g>
  );
}
