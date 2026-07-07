"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PasswordInput from "@/components/PasswordInput";
import { confirmPasswordReset } from "@/lib/api";
import { track } from "@/lib/track";

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const uid = params.get("uid") ?? "";
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const inputClass =
    "border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]";

  const linkValid = !!uid && !!token;

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await confirmPasswordReset(uid, token, password);
      track("password-reset-complete");
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reset password.");
    }
    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto w-full px-4 sm:px-6 py-12 flex-1">
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7">
        <h1 className="font-mono text-xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-5 tracking-tight">Reset password</h1>

        {!linkValid ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This reset link is missing information or malformed. Please request a new one from the login screen.
          </p>
        ) : done ? (
          <div>
            <p className="text-sm text-green-600 dark:text-green-400 mb-4">
              Your password has been reset and you are now logged in.
            </p>
            <button
              onClick={() => router.push("/")}
              className="w-full bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors"
            >
              Go to your projects
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              className={inputClass}
              autoFocus
            />
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm new password"
              className={inputClass}
            />
            {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
            >
              {loading ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="reset_password" />
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
      <SiteFooter />
    </div>
  );
}
