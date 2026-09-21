"use client";

import { useRef } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { Component } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { useBoardView } from "@/hooks/useBoardView";
import { holeCenter, HOLE_SPACING, PinPosition } from "./boardLayout";
import { PartBody, partDrawing } from "./partDrawing";

const PIN_HIT_RADIUS = HOLE_SPACING * 0.35;
const CLASH_STROKE = "#dc2626";

// Exported flag to suppress canvas click handlers after label drag
export let suppressNextCanvasClick = false;

interface Props {
  component: Component;
  isSelected: boolean;
  /** Its real body runs into another part's: outlined as a warning. */
  clashing?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onPinDragStart?: (pinId: string, e: React.MouseEvent) => void;
  readOnly?: boolean;
}

export default function PlacedComponent({ component, isSelected, clashing = false, onMouseDown, onPinDragStart, readOnly = false }: Props) {
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const { netAssignments } = useBoardView();
  const nets = useProjectStore((s) => s.nets);
  const updateBoardLabelOffset = useProjectStore((s) => s.updateBoardLabelOffset);
  const showValues = useProjectStore((s) => s.showValuesOnBoard);
  // With a tool up, a click belongs to the tool and the cursor says so
  const toolActive = useProjectStore((s) => s.boardTool !== "select");
  const pushSnapshot = useProjectStore((s) => s.pushSnapshot);
  const snapshotPushed = useRef(false);

  const handleLabelMouseDown = (e: React.MouseEvent, defaultX: number, defaultY: number) => {
    // the right button pans the board, from anywhere
    if (readOnly || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startOff = component.boardLabelOffset ?? { x: 0, y: 0 };
    snapshotPushed.current = false;

    const svgEl = (e.target as SVGElement).ownerSVGElement;
    const ctm = svgEl?.getScreenCTM();
    const scaleFactor = ctm ? 1 / ctm.a : 1;

    const handleMove = (me: MouseEvent) => {
      if (!snapshotPushed.current) {
        pushSnapshot();
        snapshotPushed.current = true;
      }
      const dx = (me.clientX - startX) * scaleFactor;
      const dy = (me.clientY - startY) * scaleFactor;
      updateBoardLabelOffset(component.id, { x: startOff.x + dx, y: startOff.y + dy });
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (snapshotPushed.current) {
        suppressNextCanvasClick = true;
        requestAnimationFrame(() => { suppressNextCanvasClick = false; });
      }
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const def = resolveComponentDef(component, componentDefs);
  const drawing = def ? partDrawing(def, component, holeCenter, HOLE_SPACING) : null;
  if (!def || !drawing) return null;
  const allowsValue = def.hasValue ?? false;
  const isFlexible = def.flexible ?? false;
  const { pins, label } = drawing;

  const renderPin = (pin: PinPosition) => {
    const center = holeCenter(pin.row, pin.col);
    const assignment = netAssignments.find(
      (a) => a.componentId === component.id && a.pinId === pin.pinId
    );
    const net = assignment ? nets.find((n) => n.id === assignment.netId) : null;
    const hasNet = !!net;

    return (
      <g key={`${pin.pinId}-${pin.row}-${pin.col}`}>
        {/* Large hit area for flexible pin dragging */}
        {isFlexible && onPinDragStart && (
          <circle
            cx={center.x}
            cy={center.y}
            r={PIN_HIT_RADIUS}
            fill="transparent"
            pointerEvents="all"
            style={{ cursor: toolActive ? undefined : "grab" }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              onPinDragStart(pin.pinId, e);
            }}
          />
        )}
        {/* Pin dot */}
        <circle
          cx={center.x}
          cy={center.y}
          r={hasNet ? 5 : 4.5}
          fill={hasNet ? net!.color : "var(--hole-fill)"}
          stroke={hasNet ? "var(--hole-fill)" : "var(--hole-stroke)"}
          strokeWidth={hasNet ? 1.5 : 0.5}
          pointerEvents="none"
        />
        {/* Pin ID label */}
        {drawing.pinNames && <text
          x={center.x}
          y={center.y + 10}
          textAnchor="middle"
          fontSize={6}
          fill={drawing.pinOnDark ? "#e8e8e8" : "var(--component-subtext)"}
          stroke={drawing.pinOnDark ? "rgba(0,0,0,0.6)" : "var(--board-fill)"}
          strokeWidth={1.6}
          paintOrder="stroke"
          strokeLinejoin="round"
          pointerEvents="none"
        >
          {def.pins.find((p) => p.id === pin.pinId)?.name ?? pin.pinId}
        </text>}
      </g>
    );
  };

  // A package carries the label on the body itself: above the part it would
  // collide with whatever is placed on the row above.
  const lx = label.x + (component.boardLabelOffset?.x ?? 0);
  const ly = label.y + (component.boardLabelOffset?.y ?? 0);
  const onBody = {
    dominantBaseline: "central" as const,
    fill: label.onDark ? "#f7f7f7" : "#1a1a1a",
    stroke: label.onDark ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.8)",
    strokeWidth: 3,
    paintOrder: "stroke",
    strokeLinejoin: "round" as const,
  };

  return (
    <g>
      <PartBody
        drawing={drawing}
        outline={isSelected ? "var(--selection-stroke)" : clashing ? CLASH_STROKE : "var(--component-stroke)"}
        outlineWidth={isSelected ? 0.26 : clashing ? 0.3 : 0.12}
        fill={isSelected ? "var(--selection-fill)" : "var(--component-fill)"}
        strokeWidth={isSelected || clashing ? 1.5 : 1}
        style={{ cursor: toolActive ? undefined : "grab" }}
        onMouseDown={onMouseDown}
      />
      {pins.map(renderPin)}
      <text
        x={lx}
        y={ly}
        textAnchor="middle" fontSize={11} fontWeight={600}
        {...(label.onBody ? onBody : { fill: "var(--component-text)" })}
        style={{ cursor: "grab" }}
        onMouseDown={(e) => handleLabelMouseDown(e, label.x, label.y)}
      >
        <tspan x={lx}>
          {component.locked ? `${component.label} \u{1F512}` : component.label}
        </tspan>
        {showValues && allowsValue && component.value && (
          <tspan x={lx} dy="1.15em" fontWeight={400} fillOpacity={0.7}>
            {component.value}
          </tspan>
        )}
      </text>
    </g>
  );
}
