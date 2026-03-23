"use client";

import { useProjectStore } from "@/store/useProjectStore";
import ComponentLibrary from "./schematic/ComponentLibrary";
import NetPanel from "./schematic/NetPanel";
import SchematicCanvas from "./schematic/SchematicCanvas";
import ResizableSidebar from "./ResizableSidebar";

export default function SchematicEditor({ readOnly = false, hideSidebar = false }: { readOnly?: boolean; hideSidebar?: boolean }) {
  const wireDrawMode = useProjectStore((s) => s.schematicWireDrawMode);
  const wireDrawingFrom = useProjectStore((s) => s.schematicWireDrawingFrom);
  const toggleWireDrawMode = useProjectStore((s) => s.toggleSchematicWireDrawMode);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      {!hideSidebar && <div className="border-b border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-5 h-12 font-semibold text-sm text-[#113768] dark:text-[#5b9bd5] flex items-center justify-between">
        <span>Schematic / Net Editor</span>
        {!readOnly && (
          <div className="flex items-center gap-3">
            {wireDrawingFrom && (
              <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                Click a pin or grid point to place wire, Esc to cancel
              </span>
            )}
            <button
              onClick={toggleWireDrawMode}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded w-[100px] justify-center ${
                wireDrawMode
                  ? "bg-[#113768] text-white"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              }`}
              title="Toggle wire drawing mode (W)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M 2 12 L 2 6 L 12 6 L 12 2" />
              </svg>
              Draw Wire
            </button>
          </div>
        )}
      </div>}

      <div className="flex flex-1 min-h-0">
        {!hideSidebar && (
          readOnly ? (
            <div className="w-48 flex-shrink-0 flex flex-col overflow-hidden border-r border-neutral-200 dark:border-neutral-700">
              <NetPanel readOnly />
            </div>
          ) : (
            <ResizableSidebar defaultWidth={220} minWidth={160} maxWidth={400}>
              <div className="flex flex-col h-full overflow-hidden border-r border-neutral-200 dark:border-neutral-700">
                <ComponentLibrary />
                <NetPanel />
              </div>
            </ResizableSidebar>
          )
        )}
        <div className="flex-1 min-w-0">
          <SchematicCanvas readOnly={readOnly} />
        </div>
      </div>
    </div>
  );
}
