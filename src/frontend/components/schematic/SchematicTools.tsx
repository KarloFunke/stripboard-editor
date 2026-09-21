"use client";

import ToolStrip, { CanvasTool, SelectToolIcon, toolIcon } from "@/components/canvas/ToolStrip";

export type SchematicTool = "select" | "wire";

const TOOLS: CanvasTool<SchematicTool>[] = [
  {
    id: "select",
    name: "Select",
    shortcut: "Esc",
    title: "Select: move and edit parts, wires and labels. A click on a pin end still starts a wire from it.",
    icon: SelectToolIcon,
  },
  {
    id: "wire",
    name: "Wire",
    shortcut: "W",
    title: "Wire: every click draws. Wires can start on pins, on other wires and on empty grid.",
    icon: toolIcon(<path d="M4 20V11h16V4" />),
  },
];

export default function SchematicTools({ tool, onChange }: { tool: SchematicTool; onChange: (tool: SchematicTool) => void }) {
  return <ToolStrip tools={TOOLS} active={tool} onChange={onChange} />;
}
