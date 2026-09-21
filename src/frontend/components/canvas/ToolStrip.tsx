"use client";

export interface CanvasTool<T extends string> {
  id: T;
  name: string;
  shortcut: string;
  title: string;
  icon: React.ReactNode;
}

export const toolIcon = (children: React.ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const SelectToolIcon = toolIcon(<path d="M5 3l14 8-6.5 1.5L11 19z" />);

/** Width the strip takes on the canvas's left edge: editors start their view clear of it. */
export const TOOL_STRIP_HOME = { x: -60, y: 0 };

/** What a click on the canvas does. Floats on the canvas, where the tools are used; the same in both editors. */
export default function ToolStrip<T extends string>({ tools, active, onChange }: {
  tools: CanvasTool<T>[];
  active: T;
  onChange: (tool: T) => void;
}) {
  return (
    <div className="absolute top-3 left-3 z-10 flex flex-col gap-0.5 bg-white/95 dark:bg-neutral-800/95 border border-neutral-200 dark:border-neutral-700 rounded-md p-1 shadow-sm dark:shadow-neutral-900/30">
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          title={t.title}
          aria-pressed={active === t.id}
          className={`flex flex-col items-center w-11 py-1 rounded border transition-colors ${active === t.id
            ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
            : "border-transparent text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
        >
          {t.icon}
          <span className="text-[10px] leading-tight mt-0.5">{t.name}</span>
          <span className="text-[9px] leading-tight font-mono opacity-60">{t.shortcut}</span>
        </button>
      ))}
    </div>
  );
}
