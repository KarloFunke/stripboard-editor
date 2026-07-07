const API_URL = process.env.NEXT_PUBLIC_API_URL!;

let csrfToken: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch(`${API_URL}/auth/csrf/`, { credentials: "include" });
  const data = await res.json();
  csrfToken = data.csrfToken;
  return csrfToken!;
}

async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };

  // Add CSRF token for mutating requests
  if (options.method && options.method !== "GET") {
    headers["X-CSRFToken"] = await getCsrfToken();
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });
}

// ── Proof of Work ────────────────────────────────────

async function fetchPowChallenge(): Promise<{ challenge: string; difficulty: number }> {
  const res = await apiFetch("/pow/challenge/");
  if (!res.ok) throw new Error("Failed to get PoW challenge");
  return res.json();
}

async function solvePoW(challenge: string, difficulty: number): Promise<string> {
  const prefix = "0".repeat(difficulty);
  const encoder = new TextEncoder();
  let nonce = 0;
  while (true) {
    const input = challenge + nonce.toString();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(input));
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hashHex.startsWith(prefix)) {
      return nonce.toString();
    }
    nonce++;
    // Yield to UI thread every 10K iterations
    if (nonce % 10000 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

async function getPoWSolution(): Promise<{ pow_challenge: string; pow_nonce: string }> {
  const { challenge, difficulty } = await fetchPowChallenge();
  const nonce = await solvePoW(challenge, difficulty);
  return { pow_challenge: challenge, pow_nonce: nonce };
}

// ── Projects ──────────────────────────────────────────

export interface PreviewData {
  components: Record<string, unknown>[];
  componentDefs: Record<string, unknown>[];
  board: Record<string, unknown>;
  nets: Record<string, unknown>[];
  netAssignments: Record<string, unknown>[];
}

export interface ProjectMeta {
  edit_uuid: string;
  view_uuid: string;
  name: string;
  fork_count: number;
  created_at: string;
  updated_at: string;
  preview_data: PreviewData | null;
}

export interface ProjectDetail extends ProjectMeta {
  data: Record<string, unknown>;
  owner_name: string | null;
}

export async function createProject(name: string, data: Record<string, unknown>): Promise<ProjectDetail> {
  const pow = await getPoWSolution();
  const res = await apiFetch("/projects/", {
    method: "POST",
    body: JSON.stringify({ name, data, ...pow }),
  });
  if (!res.ok) throw new Error("Failed to create project");
  return res.json();
}

export async function getProject(editUuid: string): Promise<ProjectDetail> {
  const res = await apiFetch(`/projects/${editUuid}/`);
  if (!res.ok) throw new Error("Project not found");
  return res.json();
}

export async function saveProject(editUuid: string, name: string, data: Record<string, unknown>): Promise<ProjectDetail> {
  const res = await apiFetch(`/projects/${editUuid}/`, {
    method: "PUT",
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error("Failed to save project");
  return res.json();
}

export async function deleteProject(editUuid: string): Promise<void> {
  const res = await apiFetch(`/projects/${editUuid}/`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete project");
}

export async function getProjectView(viewUuid: string): Promise<ProjectDetail> {
  const res = await apiFetch(`/projects/view/${viewUuid}/`);
  if (!res.ok) throw new Error("Project not found");
  return res.json();
}

export async function forkProject(viewUuid: string): Promise<ProjectDetail> {
  const res = await apiFetch(`/projects/fork/${viewUuid}/`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to fork project");
  return res.json();
}

export async function migrateProjectData(data: unknown): Promise<unknown> {
  const res = await apiFetch("/projects/migrate/", {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to migrate project");
  return res.json();
}

export async function claimProject(editUuid: string): Promise<ProjectDetail> {
  const res = await apiFetch(`/projects/${editUuid}/claim/`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to claim project");
  return res.json();
}

export async function getUserProjects(): Promise<ProjectMeta[]> {
  const res = await apiFetch("/users/me/projects/");
  if (!res.ok) throw new Error("Failed to load projects");
  return res.json();
}

// ── Auth ──────────────────────────────────────────────

export interface User {
  id: number;
  username: string;
  email?: string;
  date_joined: string;
  is_staff?: boolean;
}

// Broadcast a login/logout so components holding their own auth state (e.g. the
// header, the feedback conversation) can re-check without a full reload.
function notifyAuthChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("auth-changed"));
  }
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function register(username: string, password: string, email?: string): Promise<User> {
  csrfToken = null;
  const hashedPassword = await hashPassword(password);
  const pow = await getPoWSolution();
  const res = await apiFetch("/auth/register/", {
    method: "POST",
    body: JSON.stringify({ username, password: hashedPassword, email: email ?? "", ...pow }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.username?.[0] ?? err.password?.[0] ?? err.email?.[0] ?? "Registration failed");
  }
  csrfToken = null;
  const user = await res.json();
  notifyAuthChanged();
  return user;
}

export async function login(username: string, password: string): Promise<User> {
  csrfToken = null;
  const hashedPassword = await hashPassword(password);
  const res = await apiFetch("/auth/login/", {
    method: "POST",
    body: JSON.stringify({ username, password: hashedPassword }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Login failed");
  }
  csrfToken = null;
  const user = await res.json();
  notifyAuthChanged();
  return user;
}

export async function logout(): Promise<void> {
  await apiFetch("/auth/logout/", { method: "POST" });
  csrfToken = null;
  notifyAuthChanged();
}

export async function deleteAccount(): Promise<void> {
  const res = await apiFetch("/auth/delete-account/", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete account");
  csrfToken = null;
}

export async function changePassword(newPassword: string): Promise<void> {
  const newHash = await hashPassword(newPassword);
  const res = await apiFetch("/auth/change-password/", {
    method: "POST",
    body: JSON.stringify({ new_password: newHash }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Failed to change password");
  }
  csrfToken = null;
}

// Set or clear the account email (used for password reset). Blank clears it.
export async function setEmail(email: string): Promise<User> {
  const res = await apiFetch("/auth/email/", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.email?.[0] ?? err.error ?? "Failed to update email");
  }
  return res.json();
}

// Request a reset link. Throws if no account matches the email or the send fails.
export async function requestPasswordReset(email: string): Promise<void> {
  csrfToken = null;
  const pow = await getPoWSolution();
  const res = await apiFetch("/auth/password-reset/", {
    method: "POST",
    body: JSON.stringify({ email, ...pow }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "Could not send the reset email.");
  }
}

// Complete a reset with the uid/token from the emailed link. Logs the user in.
export async function confirmPasswordReset(uid: string, token: string, newPassword: string): Promise<User> {
  csrfToken = null;
  const newHash = await hashPassword(newPassword);
  const res = await apiFetch("/auth/password-reset/confirm/", {
    method: "POST",
    body: JSON.stringify({ uid, token, new_password: newHash }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? "This reset link is invalid or has expired.");
  }
  csrfToken = null;
  const user = await res.json();
  notifyAuthChanged();
  return user;
}

export async function getMe(): Promise<User | null> {
  const res = await apiFetch("/auth/me/");
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}

// ── Site header ───────────────────────────────────────

export interface HeaderState {
  user: User | null;
  feedbackUnread: boolean;
  inboxUnread: number;
}

// One always-200 call backing the whole header (user + unread indicators).
export async function getHeaderState(): Promise<HeaderState> {
  const res = await apiFetch("/header/");
  if (!res.ok) return { user: null, feedbackUnread: false, inboxUnread: 0 };
  return res.json();
}

// ── Feedback ──────────────────────────────────────────

export interface FeedbackReply {
  body: string;
  from_staff: boolean;
  created_at: string;
}

export interface FeedbackThread {
  id: number;
  message: string;
  created_at: string;
  replies: FeedbackReply[];
}

export async function submitFeedback(
  input: { message: string; contact?: string },
  opts?: { loggedIn?: boolean }
): Promise<void> {
  // Logged-in users skip PoW: the server doesn't require it for them, and
  // solving one would only slow the chat and leave stale challenge rows.
  const body: Record<string, unknown> = {
    message: input.message,
    contact: input.contact ?? "",
  };
  if (!opts?.loggedIn) {
    Object.assign(body, await getPoWSolution());
  }
  const res = await apiFetch("/feedback/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to submit feedback");
}

export async function getMyFeedbackThread(): Promise<FeedbackThread | null> {
  const res = await apiFetch("/feedback/mine/");
  if (!res.ok) return null;
  // DRF renders Response(None) as an empty body, not "null" — guard against it.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Staff inbox ───────────────────────────────────────

export interface AdminFeedbackThread {
  id: number;
  username: string | null;
  contact: string;
  message: string;
  created_at: string;
  last_activity: string;
  reply_count: number;
  unseen: boolean;
}

export interface AdminFeedbackThreadDetail {
  id: number;
  username: string | null;
  contact: string;
  message: string;
  created_at: string;
  replies: FeedbackReply[];
}

export async function getAdminThreads(): Promise<AdminFeedbackThread[]> {
  const res = await apiFetch("/feedback/admin/threads/");
  if (!res.ok) return [];
  return res.json();
}

export async function getAdminThread(id: number): Promise<AdminFeedbackThreadDetail | null> {
  const res = await apiFetch(`/feedback/admin/threads/${id}/`);
  if (!res.ok) return null;
  return res.json();
}

export async function replyAdminThread(id: number, body: string): Promise<AdminFeedbackThreadDetail> {
  const res = await apiFetch(`/feedback/admin/threads/${id}/reply/`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error("Failed to send reply");
  return res.json();
}
