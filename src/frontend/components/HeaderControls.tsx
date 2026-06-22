"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getHeaderState, logout, type User } from "@/lib/api";
import AuthModal from "./AuthModal";

// The whole right side of the header: staff inbox link, new-reply indicator, and
// auth controls — all driven by ONE always-200 request (getHeaderState). On the
// root page the auth UI is provided via `actions`; elsewhere this renders it.
export default function HeaderControls({ actions }: { actions?: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [feedbackUnread, setFeedbackUnread] = useState(false);
  const [inboxUnread, setInboxUnread] = useState(0);
  const [ready, setReady] = useState(false);
  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      getHeaderState().then((s) => {
        if (!active) return;
        setUser(s.user);
        setFeedbackUnread(s.feedbackUnread);
        setInboxUnread(s.inboxUnread);
        setReady(true);
      });
    load();
    // Re-fetch when the user logs in/out anywhere.
    window.addEventListener("auth-changed", load);
    return () => {
      active = false;
      window.removeEventListener("auth-changed", load);
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
    router.refresh();
  };

  return (
    <>
      {user?.is_staff && (
        <Link
          href="/inbox"
          title="Feedback inbox"
          className="flex items-center gap-1.5 font-mono text-xs text-neutral-500 dark:text-neutral-400 hover:text-[var(--copper)] transition-colors"
        >
          inbox
          {inboxUnread > 0 && (
            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-[var(--copper)] text-white text-[10px] leading-none">
              {inboxUnread}
            </span>
          )}
        </Link>
      )}

      {user && feedbackUnread && (
        <Link
          href="/feedback"
          title="You have a new reply"
          className="flex items-center gap-1.5 font-mono text-xs text-[var(--copper)] hover:underline"
        >
          <span className="h-2 w-2 rounded-full bg-[var(--copper)]" />
          reply
        </Link>
      )}

      {actions ?? (ready && (user ? (
        <>
          <span className="font-mono text-neutral-500 dark:text-neutral-400 hidden sm:inline">{user.username}</span>
          <button
            onClick={handleLogout}
            className="font-mono px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors"
          >
            logout
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => setShowAuth("login")}
            className="font-mono px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors"
          >
            login
          </button>
          <button
            onClick={() => setShowAuth("register")}
            className="font-mono px-3 py-1.5 rounded bg-[#113768] text-white border-2 border-[#113768] hover:border-[var(--copper)] transition-colors"
          >
            register
          </button>
        </>
      )))}

      {showAuth && (
        <AuthModal
          mode={showAuth}
          onMode={setShowAuth}
          onClose={() => setShowAuth(null)}
          onSuccess={(u) => {
            setUser(u);
            setShowAuth(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
