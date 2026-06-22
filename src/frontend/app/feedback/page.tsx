import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import FeedbackConversation from "@/components/FeedbackConversation";

export const metadata: Metadata = {
  title: "Feedback",
  description:
    "Send a message, idea, or bug report for the Stripboard Editor. Logged-in users can read replies and continue the conversation.",
  // Utility page with no search value: crawlable, but kept out of the index.
  robots: { index: false, follow: true },
};

export default function FeedbackPage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="feedback" />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">Feedback</h1>
          <FeedbackConversation />
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
