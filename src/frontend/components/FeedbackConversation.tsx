"use client";

import { useEffect, useState } from "react";
import {
  getMe,
  getMyFeedbackThread,
  submitFeedback,
  type FeedbackThread,
} from "@/lib/api";
import { track } from "@/lib/track";
import MessageList, { formatDateTime, type ChatMessage } from "@/components/MessageList";

const POLL_MS = 10000;

const inputClass =
  "w-full border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]";

export default function FeedbackConversation() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [thread, setThread] = useState<FeedbackThread | null>(null);
  const [loading, setLoading] = useState(true);

  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAnon, setSentAnon] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const u = await getMe();
        if (!active) return;
        setSentAnon(false);
        setLoggedIn(!!u);
        const t = u ? await getMyFeedbackThread() : null;
        if (!active) return;
        setThread(t);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    // Re-check when the user logs in/out elsewhere (e.g. the header), so the
    // page swaps to the conversation instead of showing a stale logged-out view.
    window.addEventListener("auth-changed", load);
    return () => {
      active = false;
      window.removeEventListener("auth-changed", load);
    };
  }, []);

  // Poll for new replies while logged in so the conversation stays live.
  useEffect(() => {
    if (!loggedIn) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      getMyFeedbackThread().then(setThread);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loggedIn]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await submitFeedback({ message: message.trim(), contact: contact.trim() }, { loggedIn: loggedIn === true });
      track("feedback-submit");
      setMessage("");
      setContact("");
      if (loggedIn) {
        setThread(await getMyFeedbackThread());
      } else {
        setSentAnon(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    }
    setSending(false);
  };

  if (loading) {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading...</p>;
  }

  const hasThread = !!(loggedIn && thread);
  const messages: ChatMessage[] = thread
    ? [
        { from: "You", body: thread.message, time: formatDateTime(thread.created_at), mine: true },
        ...thread.replies.map((r) => ({
          from: r.from_staff ? "Karl" : "You",
          body: r.body,
          time: formatDateTime(r.created_at),
          mine: !r.from_staff,
        })),
      ]
    : [];

  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Have an idea, a bug, or a question? Leave me a message
        {loggedIn ? ". I will reply here" : ""}.
        {loggedIn === false && " Leave an email if you'd like a reply, or log in to chat right here."}
      </p>

      {hasThread && (
        <MessageList messages={messages} className="max-h-[55vh] pr-1" />
      )}

      {sentAnon ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Thanks for the message! It has been received.
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={hasThread ? 3 : 4}
            maxLength={4000}
            required
            placeholder={hasThread ? "Reply..." : "Write a message..."}
            className={`${inputClass} resize-y`}
          />
          {loggedIn === false && (
            <input
              type="text"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={200}
              placeholder="Email (optional, for a reply)"
              className={inputClass}
            />
          )}
          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!message.trim() || sending}
              className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium border-2 border-[#113768] hover:border-[var(--copper)] hover:bg-[#0d2a50] disabled:opacity-50 disabled:hover:bg-[#113768] disabled:hover:border-[#113768] transition-colors"
            >
              {sending ? "Sending..." : hasThread ? "Send reply" : "Send"}
            </button>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              or{" "}
              <a
                href="https://github.com/KarloFunke/stripboard-editor/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-[var(--copper)]"
              >
                open a GitHub issue
              </a>
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
