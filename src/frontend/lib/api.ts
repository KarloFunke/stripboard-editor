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

// ── Projects ──────────────────────────────────────────

export interface ProjectMeta {
  edit_uuid: string;
  view_uuid: string;
  name: string;
  fork_of: number | null;
  fork_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail extends ProjectMeta {
  data: Record<string, unknown>;
  owner_name: string | null;
}

export async function createProject(name: string, data: Record<string, unknown>): Promise<ProjectDetail> {
  const res = await apiFetch("/projects/", {
    method: "POST",
    body: JSON.stringify({ name, data }),
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
  const res = await apiFetch("/auth/register/", {
    method: "POST",
    body: JSON.stringify({ username, password: hashedPassword }),
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

export async function getMe(): Promise<User | null> {
  const res = await apiFetch("/auth/me/");
  if (!res.ok) return null;
  const data = await res.json();
  return data.user;
}
