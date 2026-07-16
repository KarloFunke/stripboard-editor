"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { submitLayoutRating } from "@/lib/api";
import { track } from "@/lib/track";
import {
  SOLVER_VERSION,
  projectKeyFromPath,
  disableRatingEver,
  dismissRatingForProject,
} from "@/lib/layoutRating";

// Shown inside the auto-layout result popup. Collects a 1-5 star rating of the
// finished layout and posts it with a full project snapshot for later eval.
// Self-contained: it reads the current project id from the route and manages
// its own "don't ask" opt-outs. Parent should mount it with a fresh key per run
// so the state resets each time.
export default function LayoutRatingPrompt({
  snapshot,
  metrics,
  onDone,
}: {
  snapshot: Record<string, unknown>;
  metrics: Record<string, unknown>;
  onDone: () => void;
}) {
  const projectKey = projectKeyFromPath(usePathname());
  const [hover, setHover] = useState(0);
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");

  const submit = async (value: number) => {
    track(`rating-layout-${value}-star`);
    setStatus("sending");
    try {
      await submitLayoutRating({
        rating: value,
        snapshot,
        metrics,
        solverVersion: SOLVER_VERSION,
        projectEditUuid: projectKey,
      });
      setStatus("done");
      setTimeout(onDone, 1500);
    } catch {
      // Best-effort: a failed rating shouldn't nag or error at the user.
      onDone();
    }
  };

  if (status === "done") {
    return (
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
        Thanks for the feedback.
      </p>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-600 dark:text-neutral-300">Rate this layout to help me improve this feature</span>
        <div className="flex items-center" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              disabled={status === "sending"}
              onMouseEnter={() => setHover(n)}
              onClick={() => submit(n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              className="p-0.5 text-3xl leading-none disabled:opacity-50"
            >
              <span className={hover >= n ? "text-[var(--copper)]" : "text-neutral-300 dark:text-neutral-600"}>
                {"★"}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2">
        {projectKey && (
          <button
            type="button"
            onClick={() => { track("rating-dismiss-project"); dismissRatingForProject(projectKey); onDone(); }}
            className="text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:underline"
          >
            Don&apos;t ask on this project
          </button>
        )}
        <button
          type="button"
          onClick={() => { track("rating-dismiss-ever"); disableRatingEver(); onDone(); }}
          className="text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 hover:underline"
        >
          Don&apos;t ask again everywhere
        </button>
      </div>
    </div>
  );
}
