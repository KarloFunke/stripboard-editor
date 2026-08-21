"use client";

import { useCallback, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { extractLinks, linkify } from "@/utils/linkify";

const MAX_DESCRIPTION = 200;
const MAX_NOTES = 10000;
const PLACEHOLDER =
  "Build notes, part choices, links to datasheets. Paste a full link (https://...) and it becomes clickable.";
// Five rows of text, computed from the field's own metrics (text-sm line height,
// py-1, 1px borders, border-box) so the reader and the editor are the same box.
const DEFAULT_NOTES_HEIGHT = "calc(5 * 1.25rem + 0.5rem + 2px)";

/** Drawer under the top bar holding the project description and notes. */
export default function ProjectNotesPanel({
  readOnly = false,
  onClose,
}: {
  readOnly?: boolean;
  onClose: () => void;
}) {
  const description = useProjectStore((s) => s.description ?? "");
  const notes = useProjectStore((s) => s.notes ?? "");
  const setProjectDescription = useProjectStore((s) => s.setProjectDescription);
  const setProjectNotes = useProjectStore((s) => s.setProjectNotes);

  // Notes read as formatted text with live links; clicking swaps in the editor.
  const [editingNotes, setEditingNotes] = useState(false);
  const editing = !readOnly && editingNotes;

  // The height the box was last dragged to. Held in a ref and applied on mount
  // rather than passed as a style, so a re-render mid-drag can't snap it back.
  const notesHeight = useRef<string | null>(null);
  const sizeNotesBox = useCallback((el: HTMLElement | null) => {
    if (el) el.style.height = notesHeight.current ?? DEFAULT_NOTES_HEIGHT;
  }, []);
  const captureNotesHeight = (el: HTMLElement) => {
    notesHeight.current = el.style.height || null;
  };

  const links = extractLinks(notes);

  const labelClass = "font-mono text-neutral-600 dark:text-neutral-400 font-medium w-24 flex-shrink-0";
  // No flex sizing here: in the notes column that would let flexbox compute the
  // textarea's height and override the one the resize handle sets.
  const fieldClass =
    "min-w-0 font-sans bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded px-2.5 py-1 text-neutral-800 dark:text-neutral-200 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]";

  return (
    <div className="bg-[#113768]/5 dark:bg-[#5b9bd5]/10 border-b border-[var(--copper)]/40 px-5 py-3.5 flex items-start gap-4 text-sm">
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className={labelClass}>Description:</span>
          {readOnly ? (
            <div className={`${fieldClass} flex-1 truncate`}>
              {description
                ? linkify(description)
                : <span className="text-neutral-400 dark:text-neutral-500">None</span>}
            </div>
          ) : (
            <input
              value={description}
              maxLength={MAX_DESCRIPTION}
              onChange={(e) => setProjectDescription(e.target.value)}
              onBlur={(e) => setProjectDescription(e.target.value.trim())}
              placeholder="One line about this project, shown in your project list and on view only links"
              className={`${fieldClass} flex-1`}
            />
          )}
        </div>
        <div className="flex items-start gap-2">
          <span className={`${labelClass} pt-1`}>Notes:</span>
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            {editing ? (
              <textarea
                autoFocus
                ref={sizeNotesBox}
                value={notes}
                maxLength={MAX_NOTES}
                // Focus lands the caret at position 0 by default, which reads as
                // a jump when you clicked at the end of the text to edit it.
                onFocus={(e) => {
                  const end = e.currentTarget.value.length;
                  e.currentTarget.setSelectionRange(end, end);
                }}
                onChange={(e) => setProjectNotes(e.target.value)}
                onBlur={(e) => {
                  captureNotesHeight(e.currentTarget);
                  setProjectNotes(e.currentTarget.value.trim());
                  setEditingNotes(false);
                }}
                placeholder={PLACEHOLDER}
                className={`${fieldClass} w-full resize-y`}
              />
            ) : (
              <div
                ref={sizeNotesBox}
                tabIndex={readOnly ? undefined : 0}
                title={readOnly ? undefined : "Click to edit"}
                // A click on a link opens it; anywhere else starts editing.
                onClick={readOnly ? undefined : (e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  captureNotesHeight(e.currentTarget);
                  setEditingNotes(true);
                }}
                onFocus={readOnly ? undefined : (e) => {
                  if (e.target !== e.currentTarget) return;
                  captureNotesHeight(e.currentTarget);
                  setEditingNotes(true);
                }}
                className={`${fieldClass} w-full overflow-y-auto resize-y whitespace-pre-wrap break-words ${
                  readOnly ? "" : "cursor-text"
                }`}
              >
                {notes
                  ? linkify(notes)
                  : <span className="text-neutral-400 dark:text-neutral-500">{readOnly ? "None" : PLACEHOLDER}</span>}
              </div>
            )}
            {links.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono text-neutral-500 dark:text-neutral-400">Links:</span>
                {links.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-[#113768] dark:text-[#5b9bd5] hover:underline truncate max-w-[18rem]"
                  >
                    {url}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={onClose}
        className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-lg flex-shrink-0"
        aria-label="Close notes"
      >
        ×
      </button>
    </div>
  );
}
