"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createProject,
  getUserProjects,
  deleteProject,
  getMe,
  login,
  register,
  logout,
  type User,
  type ProjectMeta,
} from "@/lib/api";
import { useProjectStore } from "@/store/useProjectStore";

export default function HomePage() {
  const router = useRouter();
  const exportProject = useProjectStore((s) => s.exportProject);
  const resetProject = useProjectStore((s) => s.resetProject);

  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

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

  const handleNewProject = async () => {
    setCreating(true);
    try {
      resetProject();
      const data = exportProject();
      const project = await createProject("Untitled Project", data as unknown as Record<string, unknown>);
      router.push(`/project/${project.edit_uuid}`);
    } catch {
      alert("Failed to create project.");
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteProject(deleteConfirm);
    setProjects((prev) => prev.filter((p) => p.edit_uuid !== deleteConfirm));
    setDeleteConfirm(null);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const u = showAuth === "register"
        ? await register(username, password)
        : await login(username, password);
      setUser(u);
      setShowAuth(null);
      setUsername("");
      setPassword("");
      getUserProjects().then(setProjects);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : "Authentication failed");
    }
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
    <div className="min-h-screen bg-[#fafafa]">
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

      <div className="max-w-3xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-[#113768] mb-2">
            Design Stripboard Layouts
          </h1>
          <p className="text-neutral-600 text-lg">
            Create schematics, define nets, and layout components on a virtual stripboard.
            No account required to start.
          </p>
        </div>

        {/* New project */}
        <button
          onClick={handleNewProject}
          disabled={creating}
          className="w-full bg-[#113768] text-white py-3 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-50 mb-8"
        >
          {creating ? "Creating..." : "+ New Project"}
        </button>

        {/* User projects */}
        {user && (
          <div>
            <h2 className="text-lg font-semibold text-neutral-800 mb-3">Your Projects</h2>
            {projects.length === 0 ? (
              <p className="text-neutral-400 text-sm">No projects yet. Create one above.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {projects.map((project) => (
                  <div
                    key={project.edit_uuid}
                    className="bg-white border border-neutral-200 rounded-lg px-4 py-3 flex items-center justify-between hover:border-neutral-300 transition-colors"
                  >
                    <div>
                      <a
                        href={`/project/${project.edit_uuid}`}
                        className="font-medium text-[#113768] hover:underline"
                      >
                        {project.name}
                      </a>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        Updated {new Date(project.updated_at).toLocaleDateString()}
                        {project.fork_count > 0 && ` · ${project.fork_count} fork${project.fork_count > 1 ? "s" : ""}`}
                      </p>
                    </div>
                    <button
                      onClick={() => setDeleteConfirm(project.edit_uuid)}
                      className="text-neutral-400 hover:text-red-500 text-sm px-2"
                      title="Delete project"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
                className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors"
              >
                {showAuth === "login" ? "Login" : "Register"}
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
    </div>
  );
}
