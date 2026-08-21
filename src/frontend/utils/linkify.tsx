import React from "react";

// http(s) only, so a pasted "javascript:" or "data:" URI never becomes a link.
// The last character can't be punctuation, so a URL ending a sentence doesn't
// swallow the period (or the closing bracket of "(see https://…)").
const URL_PATTERN = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/g;

/** The links in a text, deduplicated, in the order they appear. */
export function extractLinks(text: string): string[] {
  return [...new Set(text.match(URL_PATTERN) ?? [])];
}

/** Split text into plain runs and clickable links. Never emits HTML. */
export function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a
        key={start}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-[#113768] dark:text-[#5b9bd5] underline underline-offset-2 break-all"
      >
        {match[0]}
      </a>
    );
    last = start + match[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
