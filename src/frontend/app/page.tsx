import { getServerSession } from "@/lib/serverSession";
import HomeClient from "./HomeClient";

export default async function HomePage() {
  const { user, projects } = await getServerSession();
  return <HomeClient initialUser={user} initialProjects={projects} />;
}
