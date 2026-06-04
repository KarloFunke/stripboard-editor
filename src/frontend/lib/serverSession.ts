import { cookies } from "next/headers";
import type { User, ProjectMeta } from "@/lib/api";

// SSR reaches Django through the same public URL the browser uses, so Django
// sees a host it already trusts. The hop loops back on the host (~1ms), not
// worth a separate internal route.
const API_BASE = process.env.NEXT_PUBLIC_API_URL!;

export interface ServerSession {
  user: User | null;
  projects: ProjectMeta[];
}

// Resolves the current user (and their projects) on the server by forwarding the
// incoming session cookie to Django. Django validates the opaque session id via a
// DB lookup, so no signing key is shared with Next. Always fetched fresh.
export async function getServerSession(): Promise<ServerSession> {
  const headers = { cookie: (await cookies()).toString() };

  let user: User | null = null;
  try {
    const res = await fetch(`${API_BASE}/auth/me/`, { headers, cache: "no-store" });
    if (res.ok) user = (await res.json()).user ?? null;
  } catch {
    // API unreachable during SSR — render the logged-out view.
    return { user: null, projects: [] };
  }

  let projects: ProjectMeta[] = [];
  if (user) {
    try {
      const res = await fetch(`${API_BASE}/users/me/projects/`, { headers, cache: "no-store" });
      if (res.ok) projects = await res.json();
    } catch {
      // Show the dashboard with an empty list rather than failing the page.
    }
  }

  return { user, projects };
}
