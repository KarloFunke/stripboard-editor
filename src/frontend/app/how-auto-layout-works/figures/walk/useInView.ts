"use client";

import { useEffect, useRef, useState } from "react";

// True once the element has come within a screen of the viewport. The figures
// that anneal a board wait for it, so opening the page costs nothing: a phone
// would otherwise run two full anneals on the main thread before the reader
// has scrolled past section 1.
export function useInView<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}
