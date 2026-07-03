import { Project } from "@/types";

// A single localStorage slot for the unsaved project on the /new route, so a
// user who edits without saving can recover their work on their next visit.
const KEY = "stripboard:new-draft";

export interface ProjectDraft {
  savedAt: number;
  project: Project;
}

export function loadDraft(): ProjectDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectDraft;
    return parsed?.project ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(project: Project) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), project } satisfies ProjectDraft));
  } catch {
    // Storage full or unavailable (private mode) — a draft is best-effort.
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function draftAge(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}
