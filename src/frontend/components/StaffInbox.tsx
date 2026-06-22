"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAdminThreads,
  getAdminThread,
  replyAdminThread,
  type AdminFeedbackThread,
  type AdminFeedbackThreadDetail,
} from "@/lib/api";
import MessageList, { formatDateTime, type ChatMessage } from "@/components/MessageList";

const POLL_MS = 10000;

const inputClass =
  "w-full border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]";

export default function StaffInbox() {
  const [threads, setThreads] = useState<AdminFeedbackThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AdminFeedbackThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const loadThreads = useCallback(async () => {
    setThreads(await getAdminThreads());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // Poll for new messages: the open conversation, or the list while browsing it.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      if (selectedId != null) {
        getAdminThread(selectedId).then((d) => d && setDetail(d));
      } else {
        getAdminThreads().then(setThreads);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [selectedId]);

  const openThread = async (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setDraft("");
    setDetail(await getAdminThread(id));
    setDetailLoading(false);
  };

  const back = () => {
    setSelectedId(null);
    setDetail(null);
    setDraft("");
    loadThreads(); // refresh order + clear the now-seen flag
  };

  const send = async () => {
    if (!draft.trim() || sending || selectedId == null) return;
    setSending(true);
    try {
      setDetail(await replyAdminThread(selectedId, draft.trim()));
      setDraft("");
    } catch {
      // keep the draft so the reply can be retried
    }
    setSending(false);
  };

  if (loading) {
    return <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading...</p>;
  }

  // ── Conversation view ──────────────────────────────
  if (selectedId != null) {
    const name = detail?.username ?? "anonymous";
    const messages: ChatMessage[] = detail
      ? [
          { from: name, body: detail.message, mine: false, time: formatDateTime(detail.created_at) },
          ...detail.replies.map((r) => ({
            from: r.from_staff ? "You" : name,
            body: r.body,
            mine: r.from_staff,
            time: formatDateTime(r.created_at),
          })),
        ]
      : [];
    return (
      <div className="space-y-4">
        <button onClick={back} className="text-sm text-[var(--copper)] hover:underline">
          ← all messages
        </button>
        {detail && (
          <div className="text-xs text-neutral-400 dark:text-neutral-500">
            {detail.username ? `@${detail.username}` : "anonymous"}
            {detail.contact ? ` · ${detail.contact}` : ""}
          </div>
        )}
        {detailLoading ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading...</p>
        ) : (
          <MessageList key={selectedId} messages={messages} className="max-h-[55vh] pr-1" />
        )}
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Write a reply..."
            className={`${inputClass} resize-y`}
          />
          <button
            onClick={send}
            disabled={!draft.trim() || sending}
            className="self-start px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] disabled:opacity-50 transition-colors"
          >
            {sending ? "Sending..." : "Send reply"}
          </button>
        </div>
      </div>
    );
  }

  // ── List view ──────────────────────────────────────
  return (
    <div className="space-y-2">
      {threads.length === 0 && (
        <p className="text-sm text-neutral-400 dark:text-neutral-500">No messages yet.</p>
      )}
      {threads.map((t) => (
        <button
          key={t.id}
          onClick={() => openThread(t.id)}
          className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
            t.unseen
              ? "border-[var(--copper)] bg-neutral-50 dark:bg-neutral-800/40"
              : "border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
          }`}
        >
          <div className="flex items-center gap-2 mb-0.5">
            {t.unseen && (
              <span className="h-2 w-2 rounded-full bg-[var(--copper)] flex-shrink-0" />
            )}
            <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">
              {t.username ?? "anonymous"}
            </span>
            {t.contact && (
              <span className="text-xs text-neutral-400 dark:text-neutral-500 truncate">{t.contact}</span>
            )}
            <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500 flex-shrink-0">
              {t.last_activity.slice(0, 10)}
            </span>
          </div>
          <div className="text-sm text-neutral-600 dark:text-neutral-400 truncate">{t.message}</div>
          <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">
            {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"}
          </div>
        </button>
      ))}
    </div>
  );
}
