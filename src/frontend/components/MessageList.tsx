"use client";

import { useEffect, useRef } from "react";

export interface ChatMessage {
  from: string;
  body: string;
  time: string;
  mine: boolean;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Bubble({ from, body, time, mine }: ChatMessage) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] min-w-0 rounded-lg px-3 py-2 text-sm ${
          mine
            ? "bg-[#113768] text-white"
            : "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
        }`}
      >
        <div
          className={`text-[10px] uppercase tracking-wider mb-0.5 ${
            mine ? "text-white/70" : "text-[var(--copper)]"
          }`}
        >
          {from}
        </div>
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</div>
        <div className={`text-[10px] mt-1 ${mine ? "text-white/60" : "text-neutral-400 dark:text-neutral-500"}`}>
          {time}
        </div>
      </div>
    </div>
  );
}

// Scrollable message log that sticks to the bottom: it auto-scrolls to the newest
// message on load and when one arrives, unless the reader has scrolled up to read
// history (in which case it leaves the scroll position alone).
export default function MessageList({ messages, className = "" }: { messages: ChatMessage[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div ref={ref} onScroll={onScroll} className={`overflow-y-auto space-y-2 ${className}`}>
      {messages.map((m, i) => (
        <Bubble key={i} {...m} />
      ))}
    </div>
  );
}
