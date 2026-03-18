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
      <div className="flex h-screen items-center justify-center bg-[#fafafa] text-neutral-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Stripboard Editor",
            url: "https://stripboard-editor.com",
            description:
              "Free online stripboard layout editor with live strip colouring. Copper strips light up in your net colours so you can instantly see what's connected.",
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
      <div className="h-12 bg-[#113768] text-white flex items-center px-6 justify-between">
        <span className="font-semibold text-lg tracking-wide">Stripboard Editor</span>
        <div className="flex items-center gap-3 text-sm">
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
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-12 flex-1">
        {/* Hero */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-[#113768] mb-2">
            Design Stripboard Layouts
          </h1>
          <p className="text-neutral-600 text-lg">
            Create schematics, define nets, and layout components on a virtual stripboard. Copper strips light up in your net colours so you can instantly see what's connected. No more tracing strips by hand.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 mb-10">
          <button
            onClick={handleNewProject}
            className="flex-1 bg-[#113768] text-white py-3 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
          >
            + New Project
          </button>
          <a
            href="/tutorial"
            className="py-3 px-6 rounded-lg text-sm font-medium border border-[#113768] text-[#113768] hover:bg-[#113768]/5 transition-colors text-center"
          >
            See Tutorial
          </a>
        </div>

        {!user && (<>
        {/* Editor screenshot */}
        <div className="mb-10">
          <a href="https://stripboard-editor.com/view/2b08cf25-5e23-4952-8df3-0d0fd385b58e">
            <img
              src="/demo-circuit.png"
              alt="Stripboard Editor — schematic and board layout side by side"
              className="rounded-lg border border-neutral-200 shadow-sm w-full hover:shadow-md transition-shadow"
            />
            <p className="text-xs text-neutral-500 mt-2 text-center">Click to view this demo circuit</p>
          </a>
        </div>

        {/* How it works */}
        <div className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 mb-4">How It Works</h2>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] font-bold">1</div>
              <p className="text-sm font-medium text-neutral-800">Add Components</p>
              <p className="text-xs text-neutral-500 mt-1">Pick from a library of common through-hole footprints or create custom ones.</p>
            </div>
            <div className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] font-bold">2</div>
              <p className="text-sm font-medium text-neutral-800">Define Nets</p>
              <p className="text-xs text-neutral-500 mt-1">Assign pins to nets to describe your circuit connectivity.</p>
            </div>
            <div className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
              <div className="text-2xl mb-2 text-[#113768] font-bold">3</div>
              <p className="text-sm font-medium text-neutral-800">Layout on Board</p>
              <p className="text-xs text-neutral-500 mt-1">Place components, wires and cuts. Strips colour-code to your nets in real time, conflicts turn red instantly.</p>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="mb-10 bg-white border border-neutral-200 rounded-lg p-5">
          <h2 className="text-lg font-semibold text-neutral-800 mb-3">Features</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-600">
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Split-screen schematic and stripboard editors</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Drag-and-drop component placement</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Live strip colouring - see net connectivity at a glance</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Customizable footprints and per-instance pin naming</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Pan, zoom, bulk select and move</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>JSON export/import, shareable edit and view-only links</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>Undo/redo</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[#113768] mt-0.5">-</span>
              <span>No account required, start designing immediately</span>
            </div>
          </div>
        </div>

        </>)}

        {/* Account benefits — only show if not logged in */}
        {!user && (
          <div className="mb-10 bg-[#113768]/5 border border-[#113768]/15 rounded-lg p-5">
            <h2 className="text-lg font-semibold text-[#113768] mb-2">Why Create an Account?</h2>
            <p className="text-sm text-neutral-600 mb-3">
              You can use this editor without an account without restrictions. But creating one takes seconds and gives you:
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-neutral-700 mb-4">
              <div className="flex items-start gap-2">
                <span className="text-[#113768] mt-0.5">-</span>
                <span>All your projects saved in one place</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[#113768] mt-0.5">-</span>
                <span>Access your work from any device</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[#113768] mt-0.5">-</span>
                <span>Shareable edit and view-only links</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[#113768] mt-0.5">-</span>
                <span>Fork other people's shared projects</span>
              </div>
            </div>
            <p className="text-xs text-neutral-500">
              No email required, just pick a username and password. Doesnt cost any money ever.
            </p>
            <button
              onClick={() => setShowAuth("register")}
              className="mt-3 bg-[#113768] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
            >
              Create Free Account
            </button>
          </div>
        )}

        {/* Account settings */}
        {user && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-neutral-800 mb-3">Account</h2>
            <div className="bg-white border border-neutral-200 rounded-lg px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-neutral-600">Logged in as <span className="font-medium text-neutral-900">{user.username}</span></span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowChangePassword(true); setPwError(null); setPwSuccess(false); setNewPw(""); }}
                  className="text-sm text-[#113768] hover:underline"
                >
                  Change Password
                </button>
                <button
                  onClick={() => setShowAccountDelete(true)}
                  className="text-sm text-red-500 hover:underline"
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
            <h2 className="text-lg font-semibold text-neutral-800 mb-3">Your Projects</h2>
            {projects.length === 0 ? (
              <p className="text-neutral-400 text-sm">No projects yet. Create one above.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {projects.map((project) => (
                  <a
                    key={project.edit_uuid}
                    href={`/project/${project.edit_uuid}`}
                    className="bg-white border border-neutral-200 rounded-lg px-4 py-3 flex items-center gap-4 hover:border-neutral-300 transition-colors"
                  >
                    {project.preview_data && (
                      <div className="flex-shrink-0">
                        <StripboardPreview data={project.preview_data} maxWidth={180} maxHeight={120} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-[#113768]">
                        {project.name}
                      </span>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        Updated {new Date(project.updated_at).toLocaleDateString()}
                        {project.fork_count > 0 && ` · ${project.fork_count} fork${project.fork_count > 1 ? "s" : ""}`}
                      </p>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); setDeleteConfirm(project.edit_uuid); }}
                      className="text-neutral-400 hover:text-red-500 text-sm px-2 flex-shrink-0"
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
            className="bg-white rounded-lg shadow-xl p-6 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">Change Password</h2>
            {pwSuccess ? (
              <div>
                <p className="text-sm text-green-600 mb-4">Password changed successfully.</p>
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
                  className="border border-neutral-300 rounded px-3 py-2 text-sm text-neutral-900 outline-none focus:border-[#113768]"
                  autoFocus
                />
                {pwError && <p className="text-xs text-red-500">{pwError}</p>}
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
            className="bg-white rounded-lg shadow-xl p-6 w-96"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">Delete Account</h2>
            <p className="text-sm text-neutral-600 mb-5">
              Are you sure? This will permanently delete your account and all your projects. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowAccountDelete(false)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-50 transition-colors"
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
                className="px-4 py-2 text-sm rounded bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
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
            className="bg-white rounded-lg shadow-xl p-6 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">Delete Project</h2>
            <p className="text-sm text-neutral-600 mb-5">
              Are you sure you want to delete{" "}
              <span className="font-medium">
                {projects.find((p) => p.edit_uuid === deleteConfirm)?.name ?? "this project"}
              </span>
              ? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 text-neutral-700 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm rounded bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
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
            className="bg-white rounded-lg shadow-xl p-6 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">
              {showAuth === "login" ? "Login" : "Register"}
            </h2>
            <form onSubmit={handleAuth} className="flex flex-col gap-3">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="border border-neutral-300 rounded px-3 py-2 text-sm text-neutral-900 outline-none focus:border-[#113768]"
                autoFocus
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="border border-neutral-300 rounded px-3 py-2 text-sm text-neutral-900 outline-none focus:border-[#113768]"
              />
              {authError && (
                <p className="text-xs text-red-500">{authError}</p>
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
              <p className="text-xs text-neutral-500 text-center">
                {showAuth === "login" ? (
                  <>No account? <button type="button" onClick={() => { setShowAuth("register"); setAuthError(null); }} className="text-[#113768] hover:underline">Register</button></>
                ) : (
                  <>Have an account? <button type="button" onClick={() => { setShowAuth("login"); setAuthError(null); }} className="text-[#113768] hover:underline">Login</button></>
                )}
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-neutral-200 mt-auto">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center justify-between text-xs text-neutral-400">
          <span>
            {"© " + new Date().getFullYear() + " "}
            <a href="https://karl-funke.com?utm_source=stripboard-editor" className="text-neutral-500 hover:text-[#113768] transition-colors">Karl Funke</a>
          </span>
          <a href="/privacy" className="text-neutral-500 hover:text-[#113768] transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
