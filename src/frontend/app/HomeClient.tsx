"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import {
  getUserProjects,
  deleteProject,
  deleteAccount,
  changePassword,
  setEmail,
  logout,
  type User,
  type ProjectMeta,
} from "@/lib/api";
import { useProjectStore } from "@/store/useProjectStore";
import StripboardPreview from "@/components/StripboardPreview";
import { track } from "@/lib/track";
import SiteHeader from "@/components/SiteHeader";
import AuthModal from "@/components/AuthModal";
import PasswordInput from "@/components/PasswordInput";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function HomeClient({
  initialUser,
  initialProjects,
}: {
  initialUser: User | null;
  initialProjects: ProjectMeta[];
}) {
  const router = useRouter();
  const resetProject = useProjectStore((s) => s.resetProject);

  const [user, setUser] = useState<User | null>(initialUser);
  const [projects, setProjects] = useState<ProjectMeta[]>(initialProjects);

  const [showAuth, setShowAuth] = useState<"login" | "register" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
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

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setProjects([]);
    router.refresh();
  };

  const steps = [
    { title: "Draw the schematic", body: "Place components from the symbol library or create your own and wire up the pins to define your nets." },
    { title: "Drop onto the board", body: "Drag parts onto the stripboard. Strips colour-code to your nets automatically." },
    { title: "Resolve conflicts", body: "Add cuts and link wires. Anything wrong lights up red the moment it happens." },
    { title: "Print and build", body: "Print a 1:1 template, lay it on the board, and push parts straight through the paper." },
  ];

  const features = [
    "Standard Schematic editor",
    "Live strip colouring with real-time conflict detection",
    "Flexible passive footprints, editable IC footprints",
    "JSON export/import, shareable edit and view links",
    "Printable 1:1 board template with cut guide and BOM",
    "Undo/redo with full history",
  ];

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Stripboard Editor",
            url: "https://stripboard-editor.com",
            description:
              "Free online stripboard layout editor with a built-in schematic editor and an automatic layout router. Draw circuits with standard symbols, wire up nets, then let the router lay out the whole board or place parts by hand with live strip colouring — print a true-scale build template with a mirrored cut guide and a bill of materials (BOM), or export a KiCad-compatible netlist to turn the prototype into a PCB.",
            applicationCategory: "DesignApplication",
            operatingSystem: "Any",
            featureList: [
              "Schematic editor with a standard symbol library",
              "Automatic stripboard layout router with per-component-type pin spacing and clearance settings",
              "Live strip colouring with real-time conflict detection",
              "Editable component footprints and custom components",
              "Printable 1:1 build template with mirrored cut guide and BOM",
              "KiCad-compatible netlist export",
              "Shareable edit and view-only project links",
            ],
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
      <SiteHeader
        actions={
          user ? (
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
          )
        }
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex-1">
        {/* Hero */}
        <div className="mb-8">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">// PCB-free prototyping</p>
          <h1 className="font-mono text-3xl sm:text-4xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-3 tracking-tight">
            Stripboard Editor
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 text-base sm:text-lg max-w-2xl">
            Draw a schematic, place the parts onto a virtual board. The copper strips will take the color of the nets with live conflict detection and an overview of what still needs to be connected.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <button
            onClick={handleNewProject}
            className="flex-1 font-mono bg-[#113768] text-white py-3 rounded-md text-sm font-medium border-2 border-[#113768] hover:border-[var(--copper)] hover:bg-[#0d2a50] transition-colors"
          >
            ▸ new project
          </button>
          <Link
            href="/guide"
            className="font-mono py-3 px-6 rounded-md text-sm font-medium border-2 border-dashed border-[#113768] dark:border-[#5b9bd5] text-[#113768] dark:text-[#5b9bd5] hover:border-[var(--copper)] hover:text-[var(--copper)] dark:hover:text-[var(--copper)] transition-colors text-center"
          >
            see short guide
          </Link>
        </div>

        {/* What's new pointer */}
        <div className="mb-12 text-sm text-neutral-600 dark:text-neutral-400 space-y-1">
          <p>Stripboard Editor is a rather new and actively developing project, with new features getting added every now and then.</p>
          <p>
            <Link href="/updates" className="font-mono text-[var(--copper)] hover:underline">
              See what&apos;s new and what&apos;s coming next →
            </Link>
          </p>
          <p>
            <Link href="/feedback" className="font-mono text-[var(--copper)] hover:underline">
              Have an idea, a bug, or a question? Leave me a message →
            </Link>
          </p>
        </div>

        {!user && (<>
        {/* Editor screenshot */}
        <div className="mb-12">
          <Link href="/view/2b08cf25-5e23-4952-8df3-0d0fd385b58e" className="block group">
            <img
              src="/demo-circuit.png"
              alt="Stripboard Editor with schematic and board layout side by side"
              className="rounded-lg border-2 border-neutral-200 dark:border-neutral-700 group-hover:border-[var(--copper)] dark:group-hover:border-[var(--copper)] shadow-sm dark:shadow-neutral-900/30 w-full transition-colors dark:hidden"
            />
            <img
              src="/demo-circuit-dark.png"
              alt="Stripboard Editor with schematic and board layout side by side"
              className="rounded-lg border-2 border-neutral-200 dark:border-neutral-700 group-hover:border-[var(--copper)] dark:group-hover:border-[var(--copper)] shadow-sm dark:shadow-neutral-900/30 w-full transition-colors hidden dark:block"
            />
            <p className="font-mono text-xs text-neutral-500 dark:text-neutral-400 mt-2 text-center">click to open this demo circuit</p>
          </Link>
        </div>

        {/* How it works */}
        <div className="mb-12">
          <h2 className="font-mono text-sm uppercase tracking-[0.2em] text-[var(--copper)] mb-5">Steps</h2>

          {/* Optional shortcut: auto-layout covers the placing and fixing steps */}
          <div className="lg:grid lg:grid-cols-4 lg:gap-px">
            <div className="lg:col-start-2 lg:col-span-2">
              <div className="rounded-lg border border-dashed border-[var(--copper)] bg-[var(--copper)]/[0.06] px-4 py-3">
                <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--copper)]">optional</span>
                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Auto-layout</p>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Skip steps 2 and 3: the router places every part, picks a board size, and works out the cuts and link wires for you.
                </p>
              </div>
              <div className="flex justify-center text-[var(--copper)] text-[10px] leading-none py-1" aria-hidden="true">▼</div>
            </div>
          </div>

          {/* Main flow */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-neutral-200 dark:bg-neutral-800">
            {steps.map((s, i) => (
              <div key={s.title} className="bg-[#fafafa] dark:bg-[#161616] p-4">
                <div className="font-mono text-[var(--copper)] text-sm mb-2">{String(i + 1).padStart(3, "0")}</div>
                <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1">{s.title}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{s.body}</p>
              </div>
            ))}
          </div>

          {/* Optional exit: take the finished circuit to an EDA tool */}
          <div className="lg:grid lg:grid-cols-4 lg:gap-px">
            <div className="lg:col-start-4">
              <div className="flex justify-center text-[var(--copper)] text-[10px] leading-none py-1" aria-hidden="true">▼</div>
              <div className="rounded-lg border border-dashed border-[var(--copper)] bg-[var(--copper)]/[0.06] px-4 py-3">
                <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--copper)]">optional</span>
                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">Export a netlist</p>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Take the finished circuit into KiCad or another EDA tool as a netlist and turn it into a real PCB.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Print demo */}
        <div className="mb-12">
          <h2 className="font-mono text-sm uppercase tracking-[0.2em] text-[var(--copper)] mb-5">print and build</h2>
          <img
            src="/print-demo.png"
            alt="Printable 1:1 stripboard build template with a parts list"
            className="rounded-lg border-2 border-neutral-200 dark:border-neutral-700 shadow-sm dark:shadow-neutral-900/30 w-full"
          />
          <p className="font-mono text-xs text-neutral-500 dark:text-neutral-400 mt-2 text-center">lay it on the board, push parts through the paper. mirrored cut guide + BOM optional.</p>
        </div>



        {/* Free banner */}
        <div className="mb-12 font-mono text-xs sm:text-sm text-center text-neutral-500 dark:text-neutral-400 border-y border-dashed border-neutral-300 dark:border-neutral-700 py-4">
          <span className="relative inline-block">
            <span className="text-[var(--copper)]">free forever</span>
            <span className="absolute left-1/2 top-full -translate-x-1/2 mt-0.5 whitespace-nowrap text-[9px] leading-none text-neutral-400 dark:text-neutral-500">(at least until AI steals my job)</span>
          </span> · account optional · no ads
        </div>

        </>)}


        {/* Account settings */}
        {user && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Account</h2>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-4 py-3 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-600 dark:text-neutral-400">Logged in as <span className="font-medium text-neutral-900 dark:text-neutral-100">{user.username}</span></span>
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
              <div className="flex items-center justify-between border-t border-neutral-100 dark:border-neutral-800 pt-3">
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
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
                  <Link
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
                      <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-0.5" suppressHydrationWarning>
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
                  </Link>
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
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
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
        <AuthModal
          mode={showAuth}
          onMode={setShowAuth}
          onClose={() => setShowAuth(null)}
          onSuccess={(u) => {
            setUser(u);
            setShowAuth(null);
            getUserProjects().then(setProjects);
            router.refresh();
          }}
        />
      )}

      {/* Footer */}
      <SiteFooter />
    </div>
  );
}
