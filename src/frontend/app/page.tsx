import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import { getServerSession } from "@/lib/serverSession";
import LandingClient from "./LandingClient";
import DashboardClient from "./DashboardClient";

export const metadata: Metadata = {
  alternates: {
    canonical: SITE_URL,
    types: { "text/markdown": `${SITE_URL}/index.md` },
  },
};

export default async function HomePage() {
  const { user, projects } = await getServerSession();
  // one address for both: the landing page, or the signed-in user's projects
  return user ? <DashboardClient initialUser={user} initialProjects={projects} /> : <LandingClient />;
}
