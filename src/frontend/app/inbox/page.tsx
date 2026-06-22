import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServerSession } from "@/lib/serverSession";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import StaffInbox from "@/components/StaffInbox";

export const metadata: Metadata = {
  title: "Inbox",
  robots: { index: false, follow: false },
};

export default async function InboxPage() {
  // SSR gate: resolve the user via the forwarded session cookie. Non-staff get a
  // 404 (the staff API endpoints enforce IsAdminUser independently).
  const { user } = await getServerSession();
  if (!user?.is_staff) notFound();

  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="inbox" />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">Inbox</h1>
          <StaffInbox />
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
