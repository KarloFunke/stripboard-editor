"use client";

import type { BoardTool } from "@/store/useProjectStore";
import ToolStrip, { CanvasTool, SelectToolIcon, toolIcon } from "@/components/canvas/ToolStrip";

const TOOLS: CanvasTool<BoardTool>[] = [
  {
    id: "select",
    name: "Select",
    shortcut: "Esc",
    title: "Select: move parts, and click a link wire or a cut to select, move or delete it.",
    icon: SelectToolIcon,
  },
  {
    id: "wire",
    name: "Wire",
    shortcut: "W",
    title: "Wire: click a hole to start a link wire and another to end it. Wires already there are ignored, so several can share a hole.",
    icon: toolIcon(<><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="6" r="2.2" /><path d="M6.6 16.4L17.4 7.6" /></>),
  },
  {
    id: "cut",
    name: "Cut",
    shortcut: "C",
    title: "Cut: click a hole to drill the strip there, or between two holes to cut it. Works under parts too. Click a cut again to remove it.",
    icon: toolIcon(<><path d="M2 12h6M16 12h6" /><path d="M9 8l6 8M15 8l-6 8" /></>),
  },
];

export default function BoardTools({ tool, onChange }: { tool: BoardTool; onChange: (tool: BoardTool) => void }) {
  return <ToolStrip tools={TOOLS} active={tool} onChange={onChange} />;
}
