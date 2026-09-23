import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import ReadDepth from "@/components/ReadDepth";
import TrackedLink from "@/components/TrackedLink";
import SiteFooter from "@/components/SiteFooter";
import { UPDATES, PLANNED } from "@/data/updates";

export const metadata: Metadata = {
  title: "What's New",
  description:
    "Recent updates to the Stripboard Editor and a look at what is planned next.",
  alternates: {
    canonical: "https://stripboard-editor.com/updates",
    types: { "text/markdown": "https://stripboard-editor.com/updates.md" },
  },
};


export default function UpdatesPage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="whats_new" />
      <ReadDepth page="updates" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">What&apos;s New</h1>

          {/* Recent updates */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-4">Recent updates</h2>
            <div className="space-y-6">
              {UPDATES.map((u) => (
                <div key={u.date}>
                  <p className="text-xs font-mono text-neutral-400 dark:text-neutral-500 mb-1.5">{u.date}</p>
                  <ul className="list-disc list-inside space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
                    {u.items.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                  {u.link && (
                    <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1.5">
                      {u.link.lead}{" "}
                      <TrackedLink from="updates" to="entry-link" href={u.link.href} className="text-[var(--copper)] hover:underline">{u.link.text}</TrackedLink>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Planned */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Planned</h2>
            <ul className="list-disc list-inside space-y-3 text-sm text-neutral-700 dark:text-neutral-300">
              {PLANNED.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-3">planned but no firm dates yet.</p>
          </section>

          {/* Feedback callout */}
          <Link
            href="/feedback"
            className="block mt-10 rounded-lg border-2 border-dashed border-[var(--copper)] px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors"
          >
            <span className="font-mono text-sm text-[var(--copper)]">Leave me a message →</span>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
              Have an idea or a question, or found a bug? Feel free to write me a message.
            </p>
          </Link>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
