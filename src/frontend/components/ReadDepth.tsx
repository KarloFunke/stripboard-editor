"use client";

import { useEffect } from "react";
import { track } from "@/lib/track";

const MARKS = [25, 50, 75, 100];

/**
 * How far down a long page the reader gets, as one event per quarter reached.
 * Pages that fit on one screen report nothing: there is no reading to measure.
 */
export default function ReadDepth({ page }: { page: string }) {
  useEffect(() => {
    let sent = 0;
    let queued = false;
    const measure = () => {
      queued = false;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable < 400) return;
      const pct = ((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100;
      for (const mark of MARKS) {
        if (pct >= mark && sent < mark) {
          sent = mark;
          track("read-depth", { page, pct: mark });
        }
      }
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => window.removeEventListener("scroll", onScroll);
  }, [page]);

  return null;
}
