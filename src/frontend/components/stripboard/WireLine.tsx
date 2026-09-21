"use client";

import { Wire } from "@/types";
import { holeCenter, STRIP_CONFLICT_COLOR } from "./boardLayout";

export type WirePart = "from" | "to" | "whole";

interface Props {
  wire: Wire;
  color: string;
  isConflict: boolean;
  // Perpendicular lane shift so overlapping parallel wires stay visible
  offset?: { dx: number; dy: number };
  /** Pressed on an end or on the run between them; absent = clicks fall through to the holes underneath. */
  onGrab?: (part: WirePart, e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  /** Another tool is in hand: keep its cursor over the wire. */
  quiet?: boolean;
}

export default function WireLine({ wire, color, isConflict, offset, onGrab, onClick, quiet }: Props) {
  const from = holeCenter(wire.from.row, wire.from.col);
  const to = holeCenter(wire.to.row, wire.to.col);
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;

  const strokeColor = isConflict ? STRIP_CONFLICT_COLOR : color;
  const grab = (part: WirePart) => (e: React.MouseEvent) => onGrab?.(part, e);

  return (
    <g onClick={onClick} pointerEvents={onGrab ? undefined : "none"}>
      {/* Invisible thick line for easier click target */}
      <line
        x1={from.x + dx}
        y1={from.y + dy}
        x2={to.x + dx}
        y2={to.y + dy}
        stroke="transparent"
        strokeWidth={10}
        strokeLinecap="round"
        style={quiet ? undefined : { cursor: "move" }}
        onMouseDown={grab("whole")}
      />
      {/* Visible wire */}
      <line
        x1={from.x + dx}
        y1={from.y + dy}
        x2={to.x + dx}
        y2={to.y + dy}
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.8}
        pointerEvents="none"
      />
      <circle cx={from.x + dx} cy={from.y + dy} r={4.5} fill={strokeColor} pointerEvents="none" />
      <circle cx={to.x + dx} cy={to.y + dy} r={4.5} fill={strokeColor} pointerEvents="none" />
      {/* An end on its own: drag it to another hole */}
      <circle cx={from.x + dx} cy={from.y + dy} r={6.5} fill="transparent" style={quiet ? undefined : { cursor: "grab" }} onMouseDown={grab("from")} />
      <circle cx={to.x + dx} cy={to.y + dy} r={6.5} fill="transparent" style={quiet ? undefined : { cursor: "grab" }} onMouseDown={grab("to")} />
    </g>
  );
}
