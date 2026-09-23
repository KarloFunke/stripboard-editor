import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import { getServerSession } from "@/lib/serverSession";
import HomeClient from "./HomeClient";

export const metadata: Metadata = {
  alternates: {
    canonical: SITE_URL,
    types: { "text/markdown": `${SITE_URL}/index.md` },
  },
};

export default async function HomePage() {
  const { user, projects } = await getServerSession();
  return <HomeClient initialUser={user} initialProjects={projects} />;
}
