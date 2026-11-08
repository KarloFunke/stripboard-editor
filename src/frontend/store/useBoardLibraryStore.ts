import { create } from "zustand";
import { getLibraryBoards, type LibraryBoard } from "@/lib/api";

// The signed-in user's own boards, shared by every project they open.
interface BoardLibraryStore {
  // null: nobody is signed in (or the library has not loaded)
  boards: LibraryBoard[] | null;
  load: () => Promise<void>;
  upsert: (board: LibraryBoard) => void;
  remove: (id: string) => void;
}

export const useBoardLibraryStore = create<BoardLibraryStore>((set, get) => ({
  boards: null,
  load: async () => {
    try {
      set({ boards: await getLibraryBoards() });
    } catch {
      set({ boards: null });
    }
  },
  upsert: (board) => {
    const current = get().boards ?? [];
    set({
      boards: current.some((b) => b.id === board.id)
        ? current.map((b) => (b.id === board.id ? board : b))
        : [...current, board],
    });
  },
  remove: (id) => set({ boards: (get().boards ?? []).filter((b) => b.id !== id) }),
}));
