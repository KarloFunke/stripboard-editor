"use client";

import { useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./netCompleteness";

import { resolveComponentDef } from "@/utils/resolveComponentDef";

export default function ComponentTray({ readOnly = false, onEditFootprint }: { readOnly?: boolean; onEditFootprint?: (componentId: string) => void }) {
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const netAssignments = useProjectStore((s) => s.netAssignments);

  const { segments, connectivity } = useStripSegments();
  const removeFromBoard = useProjectStore((s) => s.removeFromBoard);
  const rotateComponent = useProjectStore((s) => s.rotateComponent);

  const unplaced = components.filter((c) => c.boardPos === null);
  const placed = components.filter((c) => c.boardPos !== null);

  const incompleteNets = useMemo(
    () =>
      checkNetCompleteness(
        nets, netAssignments, segments, connectivity, components, componentDefs
      ),
    [nets, netAssignments, segments, connectivity, components, componentDefs]
  );

  const setTrayDragComponentId = useProjectStore((s) => s.setTrayDragComponentId);
  const setHighlightedNetId = useProjectStore((s) => s.setHighlightedNetId);

  const handleDragStart = (e: React.DragEvent, componentId: string) => {
    e.dataTransfer.setData("text/plain", componentId);
    e.dataTransfer.effectAllowed = "move";
    setTrayDragComponentId(componentId);
  };

  if (readOnly) {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {incompleteNets.length > 0 ? (
          <>
            <div className="px-3.5 py-2.5 text-xs font-semibold text-red-500 dark:text-red-400 uppercase tracking-wide">
              Incomplete Nets
            </div>
            <div className="px-2.5 pb-2.5">
              {incompleteNets.map((net) => (
                <div
                  key={net.netId}
                  className="px-2.5 py-2 mb-1.5 rounded text-sm bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800"
                  onMouseEnter={() => setHighlightedNetId(net.netId)}
                  onMouseLeave={() => setHighlightedNetId(null)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="inline-block h-3 w-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: net.netColor }}
                    />
                    <span className="font-medium text-neutral-900 dark:text-neutral-100">{net.netName}</span>
                  </div>
                  {net.groups.map((group, i) => (
                    <div key={i} className="text-neutral-600 dark:text-neutral-400 ml-5 text-sm">
                      {i > 0 && <span className="text-red-400">disconnected from: </span>}
                      {group.map((p) => `${p.componentLabel}·${p.pinName}`).join(", ")}
                    </div>
                  ))}
                  {net.unplacedPins.length > 0 && (
                    <div className="text-neutral-400 dark:text-neutral-500 ml-5 text-sm">
                      not placed: {net.unplacedPins.map((p) => `${p.componentLabel}·${p.pinName}`).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="px-3.5 py-2.5 text-xs text-neutral-400 dark:text-neutral-500">
            All nets connected
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Unplaced components */}
      <div className="px-3.5 py-2.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
        Unplaced
      </div>
      <div className="px-2.5 pb-2.5">
        {unplaced.length === 0 && (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 px-2 py-1">All components placed</p>
        )}
        {unplaced.map((comp) => {
          const def = componentDefs.find((d) => d.id === comp.defId);
          return (
            <div
              key={comp.id}
              draggable
              onDragStart={(e) => handleDragStart(e, comp.id)}
              className="flex items-center gap-2.5 px-2.5 py-2 mb-1 rounded text-sm text-neutral-900 dark:text-neutral-100 bg-neutral-50 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing transition-colors"
            >
              <span className="font-medium">{comp.label}</span>
              <span className="text-neutral-500 dark:text-neutral-400 text-sm truncate">
                {def?.name}
              </span>
            </div>
          );
        })}
      </div>

      {/* Placed components */}
      {placed.length > 0 && (
        <>
          <div className="border-t border-neutral-200 dark:border-neutral-700 px-3.5 py-2.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            On Board
          </div>
          <div className="px-2.5 pb-2.5">
            {placed.map((comp) => {
              const def = resolveComponentDef(comp, componentDefs);
              const isFlexible = def?.flexible ?? false;
              return (
                <div
                  key={comp.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 mb-1 rounded text-sm text-neutral-900 dark:text-neutral-100 bg-neutral-50 dark:bg-neutral-800"
                >
                  <span className="font-medium">{comp.label}</span>
                  <span className="text-neutral-500 dark:text-neutral-400 truncate flex-1">
                    {def?.name}
                  </span>
                  {!isFlexible && onEditFootprint && (
                    <button
                      onClick={() => onEditFootprint(comp.id)}
                      className="text-neutral-400 dark:text-neutral-500 hover:text-[#113768] dark:hover:text-[#5b9bd5] px-1"
                      title="Edit footprint"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <rect x="1" y="1" width="10" height="10" rx="1" />
                        <circle cx="3.5" cy="3.5" r="1" fill="currentColor" />
                        <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => rotateComponent(comp.id)}
                    className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 px-1"
                    title="Rotate"
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => removeFromBoard(comp.id)}
                    className="text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 px-1"
                    title="Remove from board"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Incomplete nets */}
      {incompleteNets.length > 0 && (
        <>
          <div className="border-t border-neutral-200 dark:border-neutral-700 px-3.5 py-2.5 text-xs font-semibold text-red-500 dark:text-red-400 uppercase tracking-wide">
            Incomplete Nets
          </div>
          <div className="px-2.5 pb-2.5">
            {incompleteNets.map((net) => (
              <div
                key={net.netId}
                className="px-2.5 py-2 mb-1.5 rounded text-sm bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 cursor-pointer hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                onMouseEnter={() => setHighlightedNetId(net.netId)}
                onMouseLeave={() => setHighlightedNetId(null)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="inline-block h-3 w-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: net.netColor }}
                  />
                  <span className="font-medium text-neutral-900">{net.netName}</span>
                </div>
                {net.groups.map((group, i) => (
                  <div key={i} className="text-neutral-600 ml-5 text-sm">
                    {i > 0 && <span className="text-red-400">disconnected from: </span>}
                    {group.map((p) => `${p.componentLabel}·${p.pinName}`).join(", ")}
                  </div>
                ))}
                {net.unplacedPins.length > 0 && (
                  <div className="text-neutral-400 ml-5 text-sm">
                    not placed: {net.unplacedPins.map((p) => `${p.componentLabel}·${p.pinName}`).join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
