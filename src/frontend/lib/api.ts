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
  fork_of: number | null;
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
  date_joined: string;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function register(username: string, password: string): Promise<User> {
  csrfToken = null;
  const hashedPassword = await hashPassword(password);
  const pow = await getPoWSolution();
  const res = await apiFetch("/auth/register/", {
    method: "POST",
    body: JSON.stringify({ username, password: hashedPassword, ...pow }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.username?.[0] ?? err.password?.[0] ?? "Registration failed");
  }
  csrfToken = null;
  return res.json();
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
  return res.json();
}

export async function logout(): Promise<void> {
  await apiFetch("/auth/logout/", { method: "POST" });
  csrfToken = null;
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

export async function getMe(): Promise<User | null> {
  const res = await apiFetch("/auth/me/");
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}
