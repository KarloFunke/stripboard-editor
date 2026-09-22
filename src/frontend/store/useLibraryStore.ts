import { create } from "zustand";
import type { ComponentDef } from "@/types";
import { getLibraryParts, type LibraryPart } from "@/lib/api";
import { libraryDef } from "@/data/customParts";

// The signed-in user's own parts, shared by every project they open.
interface LibraryStore {
  // null: nobody is signed in (or the library has not loaded)
  parts: LibraryPart[] | null;
  // The same parts as the panel shows them
  defs: ComponentDef[];
  load: () => Promise<void>;
  upsert: (part: LibraryPart) => void;
  remove: (id: string) => void;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  parts: null,
  defs: [],
  load: async () => {
    try {
      const parts = await getLibraryParts();
      set({ parts, defs: (parts ?? []).map(libraryDef) });
    } catch {
      set({ parts: null, defs: [] });
    }
  },
  upsert: (part) => {
    const current = get().parts ?? [];
    const parts = current.some((p) => p.id === part.id)
      ? current.map((p) => (p.id === part.id ? part : p))
      : [...current, part];
    set({ parts, defs: parts.map(libraryDef) });
  },
  remove: (id) => {
    const parts = (get().parts ?? []).filter((p) => p.id !== id);
    set({ parts, defs: parts.map(libraryDef) });
  },
}));
