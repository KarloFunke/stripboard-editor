import type { Metadata } from "next";
import PartsClient from "./PartsClient";

export const metadata: Metadata = {
  title: "My parts",
  description: "The custom parts in your library, usable in all your projects.",
  robots: { index: false },
};

export default function PartsPage() {
  return <PartsClient />;
}
