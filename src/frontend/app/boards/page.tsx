import type { Metadata } from "next";
import BoardsClient from "./BoardsClient";

export const metadata: Metadata = {
  title: "My boards",
  description: "The boards in your library, usable in all your projects.",
  robots: { index: false },
};

export default function BoardsPage() {
  return <BoardsClient />;
}
