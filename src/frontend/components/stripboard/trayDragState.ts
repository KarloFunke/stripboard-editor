/** Shared mutable state for tray drag-and-drop (module-level, not React state) */
export let trayDragComponentId = "";

export function setTrayDragComponentId(id: string) {
  trayDragComponentId = id;
}
