import type { MetadataRoute } from "next";
import { LAST_UPDATE_DATE } from "@/data/agentDocs";

// Dates are when the page's content last changed, not when it was last built:
// a build-time date tells crawlers every page changed at once on every deploy,
// which makes the signal worthless. Bump the date when you change the page.
const PAGES: [path: string, lastModified: string, changeFrequency: "monthly" | "weekly" | "yearly", priority: number][] = [
  ["", "2026-09-22", "monthly", 1],
  ["/guide", "2026-09-21", "monthly", 0.8],
  ["/how-auto-layout-works", "2026-09-21", "monthly", 0.7],
  ["/updates", LAST_UPDATE_DATE, "weekly", 0.6],
  ["/privacy", "2026-07-23", "yearly", 0.3],
];

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://stripboard-editor.com";
  return PAGES.map(([path, lastModified, changeFrequency, priority]) => ({
    url: `${baseUrl}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
