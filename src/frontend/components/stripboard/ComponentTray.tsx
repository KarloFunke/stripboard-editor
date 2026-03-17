"use client";

import { useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { useStripSegments } from "@/hooks/useStripSegments";
import { checkNetCompleteness } from "./netCompleteness";
import { setTrayDragComponentId } from "./trayDragState";

export default function ComponentTray() {
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

  const handleDragStart = (e: React.DragEvent, componentId: string) => {
    e.dataTransfer.setData("text/plain", componentId);
    e.dataTransfer.effectAllowed = "move";
    setTrayDragComponentId(componentId);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Unplaced components */}
      <div className="px-3.5 py-2.5 text-xs font-semibold text-neutral-500 uppercase tracking-wide">
        Unplaced
      </div>
      <div className="px-2.5 pb-2.5">
        {unplaced.length === 0 && (
          <p className="text-sm text-neutral-400 px-2 py-1">All components placed</p>
        )}
        {unplaced.map((comp) => {
          const def = componentDefs.find((d) => d.id === comp.defId);
          return (
            <div
              key={comp.id}
              draggable
              onDragStart={(e) => handleDragStart(e, comp.id)}
              className="flex items-center gap-2.5 px-2.5 py-2 mb-1 rounded text-sm text-neutral-900 bg-neutral-50 hover:bg-neutral-100 cursor-grab active:cursor-grabbing transition-colors"
            >
              <span className="font-medium">{comp.label}</span>
              <span className="text-neutral-500 text-sm truncate">
                {comp.tag || def?.name}
              </span>
            </div>
          );
        })}
      </div>

      {/* Placed components */}
      {placed.length > 0 && (
        <>
          <div className="border-t border-neutral-200 px-3.5 py-2.5 text-xs font-semibold text-neutral-500 uppercase tracking-wide">
            On Board
          </div>
          <div className="px-2.5 pb-2.5">
            {placed.map((comp) => {
              const def = componentDefs.find((d) => d.id === comp.defId);
              return (
                <div
                  key={comp.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 mb-1 rounded text-sm text-neutral-900 bg-neutral-50"
                >
                  <span className="font-medium">{comp.label}</span>
                  <span className="text-neutral-500 truncate flex-1">
                    {comp.tag || def?.name}
                  </span>
                  <button
                    onClick={() => rotateComponent(comp.id)}
                    className="text-neutral-400 hover:text-neutral-700 px-1.5"
                    title="Rotate"
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => removeFromBoard(comp.id)}
                    className="text-neutral-400 hover:text-red-500 px-1.5"
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
          <div className="border-t border-neutral-200 px-3.5 py-2.5 text-xs font-semibold text-red-500 uppercase tracking-wide">
            Incomplete Nets
          </div>
          <div className="px-2.5 pb-2.5">
            {incompleteNets.map((net) => (
              <div
                key={net.netId}
                className="px-2.5 py-2 mb-1.5 rounded text-sm bg-red-50 border border-red-100"
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
