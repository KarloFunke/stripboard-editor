"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import {
  getUserProjects,
  getLibraryBoards,
  getLibraryParts,
  deleteProject,
  duplicateProject,
  renameProject,
  deleteAccount,
  changePassword,
  setEmail,
  logout,
  type User,
  type ProjectMeta,
  type ProjectPage,
} from "@/lib/api";
import { useProjectStore } from "@/store/useProjectStore";
import StripboardPreview from "@/components/StripboardPreview";
import { track } from "@/lib/track";
import SiteHeader from "@/components/SiteHeader";
import PasswordInput from "@/components/PasswordInput";
import { tell } from "@/lib/dialog";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The home page of a signed-in user: their projects, libraries and account. */
export default function DashboardClient({
  initialUser,
  initialProjects,
}: {
  initialUser: User;
  initialProjects: ProjectPage;
}) {
  const router = useRouter();
  const resetProject = useProjectStore((s) => s.resetProject);

  const [user, setUser] = useState<User>(initialUser);
  // Size of the user's part library, once known
  const [partCount, setPartCount] = useState<number | null>(null);
  useEffect(() => {
    if (!user) return;
    getLibraryParts().then((parts) => setPartCount(parts ? parts.length : null)).catch(() => setPartCount(null));
  }, [user]);
  // and of their boards
  const [boardCount, setBoardCount] = useState<number | null>(null);
  useEffect(() => {
    if (!user) return;
    getLibraryBoards().then((boards) => setBoardCount(boards ? boards.length : null)).catch(() => setBoardCount(null));
  }, [user]);
  const [projects, setProjects] = useState<ProjectMeta[]>(initialProjects.results);
  // Cursor of the next (older) page of projects, null when all are shown
  const [projectsNext, setProjectsNext] = useState<string | null>(initialProjects.next);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  // Name prompt shared by rename and duplicate (the name the copy gets)
  const [nameDialog, setNameDialog] = useState<{ mode: "rename" | "duplicate"; editUuid: string; name: string } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [showAccountDelete, setShowAccountDelete] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSaving, setEmailSaving] = useState(false);

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

  const handleNameSubmit = async () => {
    if (!nameDialog) return;
    const { mode, editUuid } = nameDialog;
    const trimmed = nameDialog.name.trim();
    const current = projects.find((p) => p.edit_uuid === editUuid);
    if (!trimmed || (mode === "rename" && trimmed === current?.name)) {
      setNameDialog(null);
      return;
    }
    setNameBusy(true);
    try {
      if (mode === "rename") {
        const name = await renameProject(editUuid, trimmed);
        setProjects((prev) => prev.map((p) => (p.edit_uuid === editUuid ? { ...p, name } : p)));
      } else {
        const copy = await duplicateProject(editUuid, trimmed);
        setProjects((prev) => [copy, ...prev]);
      }
      track(mode === "rename" ? "project-rename" : "project-duplicate", { source: "home" });
      setNameDialog(null);
    } catch (e) {
      void tell(`Couldn't ${mode} the project`, e instanceof Error ? e.message : "Please try again.");
    } finally {
      setNameBusy(false);
    }
  };

  const loadMoreProjects = async () => {
    if (!projectsNext || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getUserProjects(projectsNext);
      // A project saved meanwhile moved to the top and may come round again
      setProjects((prev) => {
        const shown = new Set(prev.map((p) => p.edit_uuid));
        return [...prev, ...page.results.filter((p) => !shown.has(p.edit_uuid))];
      });
      setProjectsNext(page.next);
    } catch {
      // Stop here: the observer would otherwise retry on every render
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Load the next page when the end of the list scrolls into view
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !projectsNext || loadMoreFailed) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadMoreProjects();
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const handleLogout = async () => {
    await logout();
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      {/* Header */}
      <SiteHeader
        actions={
          <>
            <span className="font-mono text-neutral-500 dark:text-neutral-400 hidden sm:inline">{user.username}</span>
            <button
              onClick={handleLogout}
              className="font-mono px-2 sm:px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-[var(--copper)] hover:text-[var(--copper)] transition-colors"
            >
              logout
            </button>
          </>
        }
      />

      <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">{"// schematic to stripboard"}</p>
        <h1 className="font-mono text-3xl sm:text-4xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">
          Stripboard Editor
        </h1>

        {/* in the columns of the list and the side column below */}
        <div className="flex flex-col gap-3 mb-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-x-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h2 className="font-mono text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] tracking-tight">Your Projects</h2>
            <button
              onClick={handleNewProject}
              className="flex-1 font-mono bg-[#113768] text-white py-3 px-8 rounded-md text-base font-medium border-2 border-[#113768] hover:border-[var(--copper)] hover:bg-[#0d2a50] transition-colors"
            >
              ▸ new project
            </button>
          </div>
          <Link
            href="/guide"
            onClick={() => track("content-cta", { from: "home", to: "guide" })}
            className="flex items-center justify-center font-mono py-3 px-3 rounded-md text-sm font-medium border-2 border-dashed border-[#113768] dark:border-[#5b9bd5] text-[#113768] dark:text-[#5b9bd5] hover:border-[var(--copper)] hover:text-[var(--copper)] dark:hover:text-[var(--copper)] transition-colors text-center"
          >
            see short guide
          </Link>
        </div>

        <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          {/* User projects */}
          <div className="min-w-0">
            {projects.length === 0 ? (
              <p className="text-neutral-400 dark:text-neutral-500 text-sm">No projects yet. Create one above.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {projects.map((project) => (
                  <Link
                    key={project.edit_uuid}
                    href={`/project/${project.edit_uuid}`}
                    className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 sm:px-4 py-3 flex items-center gap-3 sm:gap-4 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
                  >
                    {project.preview_data && (
                      <div className="flex-shrink-0 w-24 sm:w-[180px] [&>svg]:w-full [&>svg]:h-auto">
                        <StripboardPreview data={project.preview_data} maxWidth={180} maxHeight={120} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-[#113768] dark:text-[#5b9bd5]">
                        {project.name}
                      </span>
                      {project.description && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                          {project.description}
                        </p>
                      )}
                      <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5" suppressHydrationWarning>
                        Updated {new Date(project.updated_at).toLocaleDateString()}
                        {project.fork_count > 0 && ` · ${project.fork_count} fork${project.fork_count > 1 ? "s" : ""}`}
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row items-end sm:items-center flex-shrink-0">
                      <button
                        onClick={(e) => { e.preventDefault(); setNameDialog({ mode: "rename", editUuid: project.edit_uuid, name: project.name }); }}
                        className="text-neutral-400 dark:text-neutral-500 hover:text-[#113768] dark:hover:text-[#5b9bd5] text-sm px-2 flex-shrink-0"
                        title="Rename project"
                      >
                        Rename
                      </button>
                      <button
                        onClick={(e) => { e.preventDefault(); setNameDialog({ mode: "duplicate", editUuid: project.edit_uuid, name: `${project.name} (copy)` }); }}
                        className="text-neutral-400 dark:text-neutral-500 hover:text-[#113768] dark:hover:text-[#5b9bd5] text-sm px-2 flex-shrink-0"
                        title="Make a copy of this project"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={(e) => { e.preventDefault(); setDeleteConfirm(project.edit_uuid); }}
                        className="text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 text-sm px-2 flex-shrink-0"
                        title="Delete project"
                      >
                        Delete
                      </button>
                    </div>
                  </Link>
                ))}
                {projectsNext && (
                  <div ref={moreRef} className="self-center mt-1 py-2 text-sm text-neutral-400 dark:text-neutral-500">
                    {loadMoreFailed ? "Couldn't load older projects. Reload the page to try again." : loadingMore ? "Loading older projects..." : null}
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="flex flex-col gap-6">
            {/* The user's part library */}
            <div>
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Your Custom Parts</h2>
              <Link
                href="/parts"
                onClick={() => track("content-cta", { from: "home", to: "parts" })}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
              >
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {partCount === null
                    ? "Custom parts you can use in all your projects"
                    : `${partCount} custom ${partCount === 1 ? "part" : "parts"} in your library, usable in all your projects`}
                </span>
                <span className="text-sm text-[#113768] dark:text-[#5b9bd5]">Manage parts →</span>
              </Link>
            </div>
            {/* The user's own boards */}
            <div>
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Your Custom Boards</h2>
              <Link
                href="/boards"
                onClick={() => track("content-cta", { from: "home", to: "boards" })}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
              >
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {boardCount === null || boardCount === 0
                    ? "Boards of your own, for boards the editor does not know"
                    : `${boardCount} ${boardCount === 1 ? "board" : "boards"} in your library, usable in all your projects`}
                </span>
                <span className="text-sm text-[#113768] dark:text-[#5b9bd5]">Manage boards →</span>
              </Link>
            </div>
            {/* Account settings */}
            <div>
              <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Account</h2>
              <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="text-sm text-neutral-600 dark:text-neutral-400 min-w-0 break-words">Logged in as <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.username}</span></span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setShowChangePassword(true); setPwError(null); setPwSuccess(false); setNewPw(""); setConfirmPw(""); }}
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
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-neutral-100 dark:border-neutral-800 pt-3">
                  <span className="text-sm text-neutral-600 dark:text-neutral-400 min-w-0 break-words">
                    {user.email
                      ? <>Recovery email: <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.email}</span></>
                      : <>No recovery email set <span className="text-neutral-400 dark:text-neutral-500">(fully optional, only used for password reset)</span></>}
                  </span>
                  <button
                    onClick={() => { setEmailInput(user.email ?? ""); setEmailError(null); setShowEmailModal(true); }}
                    className="text-sm text-[#113768] dark:text-[#5b9bd5] hover:underline flex-shrink-0"
                  >
                    {user.email ? "Change email" : "Add email"}
                  </button>
                </div>
              </div>
            </div>

            {/* News and feedback */}
            <div className="text-sm space-y-5">
              <p>
                <Link href="/updates" onClick={() => track("content-cta", { from: "home", to: "updates" })} className="font-mono text-[var(--copper)] hover:underline">
                  See what&apos;s new and what&apos;s coming next&nbsp;→
                </Link>
              </p>
              <p>
                <Link href="/feedback" className="font-mono text-[var(--copper)] hover:underline">
                  Have an idea, a bug, or a question? Leave me a message&nbsp;→
                </Link>
              </p>
            </div>
          </aside>
        </div>
      </div>

      {/* Change password modal */}
      {showChangePassword && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowChangePassword(false)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
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
                noValidate
                onSubmit={async (e) => {
                  e.preventDefault();
                  setPwError(null);
                  if (newPw !== confirmPw) {
                    setPwError("New passwords do not match.");
                    return;
                  }
                  try {
                    await changePassword(newPw);
                    track("password-change");
                    setPwSuccess(true);
                  } catch (err: unknown) {
                    setPwError(err instanceof Error ? err.message : "Failed to change password");
                  }
                }}
                className="flex flex-col gap-3"
              >
                <PasswordInput
                  value={newPw}
                  onChange={(e) => { setNewPw(e.target.value); setPwError(null); }}
                  placeholder="New password"
                  className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
                  autoFocus
                />
                <PasswordInput
                  value={confirmPw}
                  onChange={(e) => { setConfirmPw(e.target.value); setPwError(null); }}
                  placeholder="Confirm new password"
                  className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
                />
                {pwError && <p className="text-xs text-red-500 dark:text-red-400">{pwError}</p>}
                <button
                  type="submit"
                  disabled={!newPw || !confirmPw}
                  className="bg-[#113768] text-white py-2 rounded text-sm font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
                >
                  Change Password
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Recovery email modal */}
      {showEmailModal && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowEmailModal(false)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Recovery email</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
              Used only to reset a forgotten password. Leave blank to remove it.
            </p>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                setEmailError(null);
                const trimmed = emailInput.trim();
                if (trimmed && !EMAIL_RE.test(trimmed)) {
                  setEmailError("Enter a valid email, or leave it blank.");
                  return;
                }
                setEmailSaving(true);
                try {
                  const updated = await setEmail(trimmed);
                  track("email-change", { action: trimmed ? "set" : "remove" });
                  setUser(updated);
                  setShowEmailModal(false);
                } catch (err: unknown) {
                  setEmailError(err instanceof Error ? err.message : "Failed to update email");
                }
                setEmailSaving(false);
              }}
              className="flex flex-col gap-3"
            >
              <input
                type="email"
                value={emailInput}
                onChange={(e) => { setEmailInput(e.target.value); setEmailError(null); }}
                placeholder="you@example.com"
                className="border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-[#113768] dark:focus:border-[#5b9bd5]"
                autoFocus
              />
              {emailError && <p className="text-xs text-red-500 dark:text-red-400">{emailError}</p>}
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowEmailModal(false)}
                  className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={emailSaving}
                  className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
                >
                  {emailSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
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
            className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-6 w-96"
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
                  setShowAccountDelete(false);
                  router.refresh();
                }}
                className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Delete Account
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Name prompt: rename, or the name of a duplicate */}
      {nameDialog && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setNameDialog(null)}
        >
          <form
            className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void handleNameSubmit(); }}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
              {nameDialog.mode === "rename" ? "Rename Project" : "Duplicate Project"}
            </h2>
            <input
              autoFocus
              onFocus={(e) => e.target.select()}
              value={nameDialog.name}
              maxLength={255}
              onChange={(e) => setNameDialog({ ...nameDialog, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape") setNameDialog(null); }}
              className="w-full border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-800 outline-none focus:border-blue-400 mb-5"
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setNameDialog(null)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={nameBusy}
                className="px-4 py-2 text-sm rounded bg-[#113768] text-white font-medium hover:bg-[#0d2a50] transition-colors disabled:opacity-60"
              >
                {nameDialog.mode === "rename" ? "Rename" : nameBusy ? "Duplicating..." : "Duplicate"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-300 dark:border-neutral-600 shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
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


      {/* Footer */}
      <SiteFooter />
    </div>
  );
}
