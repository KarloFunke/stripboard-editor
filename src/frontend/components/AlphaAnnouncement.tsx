"use client";

import { useEffect, useState } from "react";

// One-time announcement for the auto-layout alpha. Rendered client-only and
// gated by a localStorage flag, so it never appears in the server-rendered
// HTML (no SEO impact) and shows at most once per browser.
const SEEN_KEY = "seen-auto-layout-alpha";

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // ignore
  }
}

export default function AlphaAnnouncement() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setShow(true);
    } catch {
      // localStorage unavailable (private mode etc.) — just don't show.
    }
  }, []);

  const dismiss = () => {
    setShow(false);
    markSeen();
  };

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
      onClick={dismiss}
    >
      <div
        className="font-mono bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-lg font-semibold text-[#113768] dark:text-[#5b9bd5]">
            New: Auto-layout <span className="text-neutral-400 dark:text-neutral-500 text-sm font-normal">(alpha)</span>
          </h2>
          <button
            onClick={dismiss}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-xl leading-none"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>

        <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
          You can now let the editor arrange a whole stripboard for you. Press <strong>Auto-layout</strong> and it places
          every part, picks a board size, and adds the strip cuts and link wires to complete the board.
        </p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed mt-2">
          It is an early alpha, so expect to tidy the odd result by hand. Feedback is very welcome.
        </p>

        <div className="flex items-center justify-end gap-3 mt-5">
          <a
            href="/guide/auto-layout"
            target="_blank"
            rel="noopener noreferrer"
            onClick={dismiss}
            className="text-sm text-[var(--copper)] hover:underline"
          >
            How it works &rarr;
          </a>
          <button
            onClick={dismiss}
            className="text-sm rounded border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
