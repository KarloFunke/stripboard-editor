import { track } from "@/lib/track";

const seen = new Set<string>();

/**
 * One event per demo and action for as long as the tab lives. Stepping a demo
 * two hundred times says no more than stepping it once, and sending all of it
 * would bury the rest of the page's events.
 */
export function trackDemo(demo: string, action: string) {
  const key = `${demo}:${action}`;
  if (seen.has(key)) return;
  seen.add(key);
  track("explainer-demo", { demo, action });
}
