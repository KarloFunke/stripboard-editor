"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getUserProjects,
  deleteProject,
  deleteAccount,
  changePassword,
  getMe,
  login,
  register,
  logout,
  type User,
  type ProjectMeta,
} from "@/lib/api";
import { useProjectStore } from "@/store/useProjectStore";
import StripboardPreview from "@/components/StripboardPreview";
import { track } from "@/lib/track";
import ThemeToggle from "@/components/ThemeToggle";

export default function HomePage() {
  const router = useRouter();
  const resetProject = useProjectStore((s) => s.resetProject);

  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showAccountDelete, setShowAccountDelete] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  useEffect(() => {
    getMe()
      .then((u) => {
        setUser(u);
        if (u) {
          getUserProjects().then(setProjects);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleNewProject = () => {
    resetProject();
    track("project-create");
    router.push("/project/new");
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteProject(deleteConfirm);
    setProjects((prev) => prev.filter((p) => p.edit_uuid !== deleteConfirm));
    setDeleteConfirm(null);
  };

  const handleAuth = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const u = showAuth === "register"
        ? await register(username, password)
        : await login(username, password);
      track(showAuth === "register" ? "account-register" : "account-login");
      setUser(u);
      setShowAuth(null);
      setUsername("");
      setPassword("");
      getUserProjects().then(setProjects);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Authentication failed");
    }
    setAuthLoading(false);
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setProjects([]);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#fafafa] dark:bg-[#121212] text-neutral-500 dark:text-neutral-400">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Stripboard Editor",
            url: "https://stripboard-editor.com",
            description:
              "Free online stripboard layout editor with a built-in schematic editor. Draw circuits with standard symbols, wire up nets, and layout on a virtual stripboard with live strip colouring.",
            applicationCategory: "DesignApplication",
            operatingSystem: "Any",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "EUR",
            },
            author: {
              "@type": "Person",
              name: "Karl Funke",
              url: "https://karl-funke.com",
            },
          }),
        }}
      />
      {/* Header */}
      <div className="h-12 bg-[#113768] text-white flex items-center px-4 sm:px-6 justify-between">
        <span className="font-semibold text-base sm:text-lg tracking-wide">Stripboard Editor</span>
        <div className="flex items-center gap-2 sm:gap-3 text-sm">
          {user ? (
            <>
              <span className="opacity-70">{user.username}</span>
              <button
                onClick={handleLogout}
                className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setShowAuth("login")}
                className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
              >
                Login
              </button>
              <button
                onClick={() => setShowAuth("register")}
                className="px-3 py-1 rounded bg-white/20 hover:bg-white/30 transition-colors"
              >
                Register
              </button>
            </>
          )}
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex-1">
        {/* Hero */}
        <div className="mb-10">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-2">
            Design Stripboard Layouts
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 text-base sm:text-lg">
            Draw schematics with standard component symbols, wire up your nets, and place everything on a virtual stripboard. Copper strips light up in your net colours so you can instantly see what is connected.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 mb-10">
          <button
            onClick={handleNewProject}
            className="flex-1 bg-[#113768] text-white py-3 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
          >
            + New Project
          </button>
          <a
            href="/guide"
            className="py-3 px-6 rounded-lg text-sm font-medium border border-[#113768] dark:border-[#5b9bd5] text-[#113768] dark:text-[#5b9bd5] hover:bg-[#113768]/5 dark:hover:bg-[#5b9bd5]/10 transition-colors text-center"
          >
            Quick Guide
          </a>
        </div>

        {!user && (<>
        {/* Editor screenshot */}
        <div className="mb-10">
          <a href="https://stripboard-editor.com/view/2b08cf25-5e23-4952-8df3-0d0fd385b58e">
            <img
              src="/demo-circuit.png"
              alt="Stripboard Editor with schematic and board layout side by side"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm dark:shadow-neutral-900/30 w-full hover:shadow-md transition-shadow dark:hidden"
            />
            <img
              src="/demo-circuit-dark.png"
              alt="Stripboard Editor with schematic and board layout side by side"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm dark:shadow-neutral-900/30 w-full hover:shadow-md transition-shadow hidden dark:block"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2 text-center">Click to view this demo circuit</p>
          </a>
        </div>

        {/* How it works */}
        <div className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-4">How It Works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] dark:text-[#5b9bd5] font-bold">1</div>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Draw Schematic</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Add components with standard symbols from the library and draw wires between pins to define your nets.</p>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] dark:text-[#5b9bd5] font-bold">2</div>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Place on Board</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Drag components from the schematic onto the stripboard. Strips colour-code to your nets automatically.</p>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] dark:text-[#5b9bd5] font-bold">3</div>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Verify and Finish</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Place cuts and wires to resolve conflicts. Conflicts highlight red instantly so you know exactly what to fix.</p>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="mb-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg p-5">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-600 dark:text-neutral-400">
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Schematic editor with standard component symbols</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Wire-based net definition with automatic net inference</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Live strip colouring with real-time conflict detection</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Flexible footprints for passive components, editable for ICs</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Pan, zoom, bulk select and move on both editors</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>JSON export/import, shareable edit and view-only links</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Undo/redo with full history</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>No account required, start designing immediately</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] dark:text-[#5b9bd5] mt-0.5">-</span>
              <span>Completely free, no ads, no paywalls</span>
            </div>
          </div>
        </div>

        </>)}


        {/* Account settings */}
        {user && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Account</h2>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-neutral-600 dark:text-neutral-400">Logged in as <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.username}</span></span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowChangePassword(true); setPwError(null); setPwSuccess(false); setNewPw(""); }}
                  className="text-sm text-[#113768] dark:text-[#5b9bd5] hover:underline"
                >
                  Change Password
                </button>
                <button
                  onClick={() => setShowAccountDelete(true)}
                  className="text-sm text-red-500 dark:text-red-400 hover:underline"
                >
                  Delete Account
                </button>
              </div>
            </div>
          </div>
        )}

        {/* User projects */}
        {user && (
          <div>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Your Projects</h2>
            {projects.length === 0 ? (
              <p className="text-neutral-400 dark:text-neutral-500 text-sm">No projects yet. Create one above.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {projects.map((project) => (
                  <a
                    key={project.edit_uuid}
                    href={`/project/${project.edit_uuid}`}
                    className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex items-center gap-4 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
                  >
                    {project.preview_data && (
                      <div className="flex-shrink-0">
                        <StripboardPreview data={project.preview_data} maxWidth={180} maxHeight={120} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-[#113768] dark:text-[#5b9bd5]">
                        {project.name}
                      </span>
                      <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5">
                        Updated {new Date(project.updated_at).toLocaleDateString()}
                        {project.fork_count > 0 && ` · ${project.fork_count} fork${project.fork_count > 1 ? "s" : ""}`}
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); setDeleteConfirm(project.edit_uuid); }}
                      className="text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 text-sm px-2 flex-shrink-0"
                      title="Delete project"
                    >
                      Delete
                    </button>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Change password modal */}
      {showChangePassword && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowChangePassword(false)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">Change Password</h2>
            {pwSuccess ? (
              <div>
                <p className="text-sm text-green-600 dark:text-green-400 mb-4">Password changed successfully.</p>
                <button
                  onClick={() => setShowChangePassword(false)}
                  className="w-full bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setPwError(null);
                  try {
                    await changePassword(newPw);
                    setPwSuccess(true);
                  } catch (err: unknown) {
                    setPwError(err instanceof Error ? err.message : "Failed to change password");
                  }
                }}
                className="flex flex-col gap-3"
              >
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New password"
                  className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
                  autoFocus
                />
                {pwError && <p className="text-xs text-red-500 dark:text-red-400">{pwError}</p>}
                <button
                  type="submit"
                  disabled={!newPw}
                  className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
                >
                  Change Password
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Delete account modal */}
      {showAccountDelete && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowAccountDelete(false)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-96"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Delete Account</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
              Are you sure? This will permanently delete your account and all your projects. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowAccountDelete(false)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await deleteAccount();
                  setUser(null);
                  setProjects([]);
                  setShowAccountDelete(false);
                }}
                className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Delete Account
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Delete Project</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
              Are you sure you want to delete{" "}
              <span className="font-medium">
                {projects.find((p) => p.edit_uuid === deleteConfirm)?.name ?? "this project"}
              </span>
              ? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Auth modal */}
      {showAuth && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowAuth(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
              {showAuth === "login" ? "Login" : "Register"}
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
              {authError && (
                <p className="text-xs text-red-500 dark:text-red-400">{authError}</p>
              )}
              <button
                type="submit"
                disabled={authLoading}
                className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
              >
                {authLoading
                  ? (showAuth === "login" ? "Logging in..." : "Registering...")
                  : (showAuth === "login" ? "Login" : "Register")}
              </button>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
                {showAuth === "login" ? (
                  <>No account? <button type="button" onClick={() => { setShowAuth("register"); setAuthError(null); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Register</button></>
                ) : (
                  <>Have an account? <button type="button" onClick={() => { setShowAuth("login"); setAuthError(null); }} className="text-[#113768] dark:text-[#5b9bd5] hover:underline">Login</button></>
                )}
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-neutral-200 dark:border-neutral-700 mt-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between text-xs text-neutral-400 dark:text-neutral-500">
          <span>
            {"© " + new Date().getFullYear() + " "}
            <a href="https://karl-funke.com?utm_source=stripboard-editor" className="text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] transition-colors">Karl Funke</a>
          </span>
          <a href="/privacy" className="text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
