"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, register, requestPasswordReset, type User } from "@/lib/api";
import { track } from "@/lib/track";
import PasswordInput from "@/components/PasswordInput";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AuthModal({
  mode,
  onMode,
  onClose,
  onSuccess,
}: {
  mode: "login" | "register";
  onMode: (mode: "login" | "register") => void;
  onClose: () => void;
  onSuccess: (user: User) => void;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string; email?: string }>({});
  const [loading, setLoading] = useState(false);
  // "forgot" swaps the credential form for the reset-request form; "forgot-sent"
  // shows the confirmation. Both are local so the parent's login/register mode
  // is untouched.
  const [view, setView] = useState<"form" | "forgot" | "forgot-sent">("form");

  const handleAuth = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const errs: { username?: string; password?: string; email?: string } = {};
    if (!username.trim()) errs.username = "Username is required.";
    if (!password) errs.password = "Password is required.";
    if (mode === "register" && email.trim() && !EMAIL_RE.test(email.trim())) {
      errs.email = "Enter a valid email, or leave it blank.";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);
    try {
      const u = mode === "register"
        ? await register(username, password, email.trim() || undefined)
        : await login(username, password);
      track(mode === "register" ? "account-register" : "account-login");
      onSuccess(u);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
    setLoading(false);
  };

  const handleForgot = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(email.trim());
      track("password-reset-request");
      setView("forgot-sent");
    } catch (err: unknown) {
      // e.g. no account with that email, or a delivery failure.
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
    setLoading(false);
  };

  const inputClass =
    "w-full border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]";

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className={`bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] mx-4 sm:mx-0 ${
          mode === "register" ? "sm:w-96 max-w-md" : "sm:w-80 max-w-sm"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {view === "forgot-sent" ? (
          <>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-3">Check your email</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              A password reset link is on its way. The link is valid for one hour.
            </p>
            <button
              onClick={() => { onClose(); router.push("/"); }}
              className="w-full bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors"
            >
              Back to home
            </button>
          </>
        ) : view === "forgot" ? (
          <>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">Reset password</h2>
            <form onSubmit={handleForgot} className="flex flex-col gap-3">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Enter the email on your account and we&apos;ll send a reset link.
              </p>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className={inputClass}
                autoFocus
              />
              {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
              >
                {loading ? "Sending..." : "Send reset link"}
              </button>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
                <button type="button" onClick={() => { setView("form"); setError(null); setFieldErrors({}); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">
                  Back to login
                </button>
              </p>
            </form>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
              {mode === "login" ? "Login" : "Register"}
            </h2>
            <form onSubmit={handleAuth} noValidate className="flex flex-col gap-3">
              <div>
                <input
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setFieldErrors((p) => ({ ...p, username: undefined })); }}
                  placeholder="Username"
                  className={inputClass}
                  autoFocus
                />
                {fieldErrors.username && (
                  <p className="mt-1 text-xs text-red-500 dark:text-red-400">{fieldErrors.username}</p>
                )}
              </div>
              <div>
                <PasswordInput
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setFieldErrors((p) => ({ ...p, password: undefined })); }}
                  placeholder="Password"
                  className={inputClass}
                />
                {fieldErrors.password && (
                  <p className="mt-1 text-xs text-red-500 dark:text-red-400">{fieldErrors.password}</p>
                )}
              </div>
              {mode === "register" && (
                <div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setFieldErrors((p) => ({ ...p, email: undefined })); }}
                    placeholder="Email (optional, for password reset)"
                    className={inputClass}
                  />
                  {fieldErrors.email && (
                    <p className="mt-1 text-xs text-red-500 dark:text-red-400">{fieldErrors.email}</p>
                  )}
                </div>
              )}
              {error && (
                <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
              >
                {loading
                  ? (mode === "login" ? "Logging in..." : "Registering...")
                  : (mode === "login" ? "Login" : "Register")}
              </button>
              {mode === "login" && (
                <button
                  type="button"
                  onClick={() => { setView("forgot"); setError(null); setFieldErrors({}); }}
                  className="text-xs text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] hover:underline text-center"
                >
                  Forgot password?
                </button>
              )}
              <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
                {mode === "login" ? (
                  <>No account? <button type="button" onClick={() => { onMode("register"); setError(null); setFieldErrors({}); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Register</button></>
                ) : (
                  <>Have an account? <button type="button" onClick={() => { onMode("login"); setError(null); setFieldErrors({}); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Login</button></>
                )}
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
