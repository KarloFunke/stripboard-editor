// Shared state for the post-auto-layout rating prompt: the solver version tag,
// and the localStorage flags that let a user silence the prompt on one project
// or everywhere. All access is SSR-safe and swallows storage errors.

// Bump when the router changes meaningfully, so ratings bucket by version.
export const SOLVER_VERSION = "alpha 2.0";

const DISABLED_EVER_KEY = "rate-auto-layout-disabled";
const DISMISSED_PROJECTS_KEY = "rate-auto-layout-dismissed-projects";

/** The project id from a project route, or null on /project/new and elsewhere. */
export function projectKeyFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "project" && parts[1] && parts[1] !== "new") return parts[1];
  return null;
}

function readDismissedProjects(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Whether the rating prompt should be offered for the given project. */
export function isLayoutRatingEnabled(projectKey: string | null): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (localStorage.getItem(DISABLED_EVER_KEY)) return false;
  } catch {
    return false;
  }
  if (projectKey && readDismissedProjects().includes(projectKey)) return false;
  return true;
}

/** Silence the prompt on every project, permanently. */
export function disableRatingEver(): void {
  try {
    localStorage.setItem(DISABLED_EVER_KEY, "1");
  } catch {
    // ignore
  }
}

/** Silence the prompt on just this project. */
export function dismissRatingForProject(projectKey: string | null): void {
  if (!projectKey) return;
  try {
    const list = readDismissedProjects();
    if (!list.includes(projectKey)) {
      localStorage.setItem(DISMISSED_PROJECTS_KEY, JSON.stringify([...list, projectKey]));
    }
  } catch {
    // ignore
  }
}
