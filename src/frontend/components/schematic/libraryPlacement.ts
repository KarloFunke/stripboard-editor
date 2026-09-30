import type { NetLabelKind } from "@/types";

// A click on a library tile adds the part or flag where the schematic canvas
// finds room in its view. The canvas owns the view and the selection, so it
// registers the placing here and the library panel calls it.

/** What a tile adds, as its drag payload carries it */
export type LibraryItem = { defId: string } | { flag: NetLabelKind; name?: string };

let placer: ((item: LibraryItem) => void) | null = null;

export function registerLibraryPlacer(fn: (item: LibraryItem) => void): () => void {
  placer = fn;
  return () => {
    if (placer === fn) placer = null;
  };
}

export function placeFromLibrary(item: LibraryItem) {
  placer?.(item);
}
