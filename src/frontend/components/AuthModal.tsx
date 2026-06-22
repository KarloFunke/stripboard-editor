"use client";

import { useState } from "react";
import { login, register, type User } from "@/lib/api";
import { track } from "@/lib/track";

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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const u = mode === "register"
        ? await register(username, password)
        : await login(username, password);
      track(mode === "register" ? "account-register" : "account-login");
      onSuccess(u);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
          {mode === "login" ? "Login" : "Register"}
        </h2>
        <form onSubmit={handleAuth} className="flex flex-col gap-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
            autoFocus
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
          />
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
          <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
            {mode === "login" ? (
              <>No account? <button type="button" onClick={() => { onMode("register"); setError(null); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Register</button></>
            ) : (
              <>Have an account? <button type="button" onClick={() => { onMode("login"); setError(null); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Login</button></>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
