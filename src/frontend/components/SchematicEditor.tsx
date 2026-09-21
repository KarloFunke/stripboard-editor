"use client";

import { useEffect, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { netDiffIsEmpty, type NetDiff } from "@/components/schematic/netInference";
import ComponentLibrary from "./schematic/ComponentLibrary";
import NetPanel from "./schematic/NetPanel";
import SchematicCanvas from "./schematic/SchematicCanvas";
import ResizableSidebar from "./ResizableSidebar";

/** A handful of pin names, the rest counted */
function PinList({ pins, max = 6 }: { pins: string[]; max?: number }) {
  const shown = pins.slice(0, max);
  return (
    <>
      <span className="font-medium text-neutral-800 dark:text-neutral-200">{shown.join(", ")}</span>
      {pins.length > shown.length && <> and {pins.length - shown.length} more</>}
    </>
  );
}

export default function SchematicEditor({ readOnly = false, hideSidebar = false }: { readOnly?: boolean; hideSidebar?: boolean }) {
  const wireDrawingFrom = useProjectStore((s) => s.schematicWireDrawingFrom);
  const isActive = useProjectStore((s) => s.activeEditor === "schematic");
  const setActiveEditor = useProjectStore((s) => s.setActiveEditor);
  const netMergeNotice = useProjectStore((s) => s.netMergeNotice);
  const wiring = useProjectStore((s) => s.wiring);
  const previewWiringSwitch = useProjectStore((s) => s.previewWiringSwitch);
  const switchWiringToTouch = useProjectStore((s) => s.switchWiringToTouch);
  const [switchPreview, setSwitchPreview] = useState<NetDiff | null>(null);
  // Show a join of nets for a few seconds; Ctrl+Z takes it back
  const [notice, setNotice] = useState<typeof netMergeNotice>(null);
  useEffect(() => {
    if (!netMergeNotice) return;
    setNotice(netMergeNotice);
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [netMergeNotice]);

  return (
    <div
      className="relative flex h-full flex-col"
      onMouseDownCapture={readOnly ? undefined : () => setActiveEditor("schematic")}
    >
      {/* Header */}
      {!hideSidebar && <div className="border-b border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-5 h-12 font-semibold text-sm text-[#113768] dark:text-[#5b9bd5] flex items-center justify-between">
        <span className="font-mono">Schematic / Net Editor</span>
        {!readOnly && (
          <div className="flex items-center gap-3">
            {wiring !== "touch" && (
              <button
                onClick={() => setSwitchPreview(previewWiringSwitch())}
                className="text-xs font-normal text-neutral-500 dark:text-neutral-400 hover:text-[var(--copper)] underline decoration-dotted underline-offset-2"
                title="This project uses classic wiring: wires connect only at their ends. Touch wiring connects whatever touches. Click to see what switching would change."
              >
                Classic wiring
              </button>
            )}
            {wireDrawingFrom && (
              <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">
                Click a pin, wire or grid point to place the wire. Enter finishes, Backspace steps back, Esc cancels
              </span>
            )}
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
                <div className="flex flex-col shrink-0 max-h-[25%] min-h-0">
                  <NetPanel />
                </div>
              </div>
            </ResizableSidebar>
          )
        )}
        <div className="flex-1 min-w-0">
          <SchematicCanvas readOnly={readOnly} />
        </div>
      </div>
      {!readOnly && isActive && (
        <div className="pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-[var(--copper)]/70" />
      )}
      {!readOnly && notice && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-40 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-800/95 shadow-sm dark:shadow-neutral-900/30 px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-200">
          {notice.merges.map((m) => (
            <span key={m.into} className="mr-2">
              Joined {m.joined.join(", ")} into <span className="font-semibold">{m.into}</span>
            </span>
          ))}
          <span className="text-neutral-400 dark:text-neutral-500">Ctrl+Z to undo</span>
        </div>
      )}

      {/* Switch an old project from classic to touch wiring, after showing what joins */}
      {switchPreview && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setSwitchPreview(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-[26rem] max-w-md mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Switch to touch wiring</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              This project uses the legacy <span className="font-medium">classic wiring</span>: wires connect only where they end, as it was drawn.
              With the new <span className="font-medium">touch wiring system</span> whatever touches is connected: a wire drawn across a pin, a wire end resting on another wire, a part parked on a wire.
            </p>
            {netDiffIsEmpty(switchPreview) ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">Nothing in this schematic touches without being connected already, so no net would change.</p>
            ) : (
              <div className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
                <p className="mb-1.5">Switching to the new system would change these nets:</p>
                <ul className="list-disc list-inside space-y-1 max-h-52 overflow-y-auto">
                  {switchPreview.merges.map((m) => (
                    <li key={`m-${m.into}`}>
                      Join {m.joined.join(", ")} into <span className="font-medium text-neutral-800 dark:text-neutral-200">{m.into}</span>
                    </li>
                  ))}
                  {switchPreview.joins.map((j) => (
                    <li key={`j-${j.net}`}>
                      Connect <PinList pins={j.pins} /> to <span className="font-medium text-neutral-800 dark:text-neutral-200">{j.net}</span>
                    </li>
                  ))}
                  {switchPreview.newNets.map((n, i) => (
                    <li key={`n-${i}`}>
                      Make a new net of <PinList pins={n.pins} />
                    </li>
                  ))}
                  {switchPreview.renames.map((r) => (
                    <li key={`r-${r.from}`}>
                      Rename {r.from} to <span className="font-medium text-neutral-800 dark:text-neutral-200">{r.to}</span>, from a flag it would touch
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                  Pins joining a net change what the stripboard has to wire up. You can undo the switch with Ctrl+Z.
                </p>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSwitchPreview(null)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Keep classic
              </button>
              <button
                onClick={() => {
                  switchWiringToTouch();
                  setSwitchPreview(null);
                }}
                className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] transition-colors"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
