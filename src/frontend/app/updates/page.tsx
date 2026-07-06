import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "What's New",
  description:
    "Recent updates to the Stripboard Editor and a look at what is planned next.",
  alternates: { canonical: "https://stripboard-editor.com/updates" },
};

const updates: { date: string; items: string[] }[] = [
  {
    date: "2026-07-06",
    items: [
      "Exclude a schematic component from the stripboard (select it and press E, or use Exclude in the floating menu). Excluded parts stay in the schematic but are ignored by the board and its net checks, so you can draw a full circuit while only building part of it on the stripboard.",
    ],
  },
  {
    date: "2026-07-03",
    items: [
      "Saving unsafed projects in local storage with the option to restore them when opening a new project again.",
      "Move a whole multi-selection of components at once by dragging it, on both the schematic and the stripboard (previously only possible with the arrow keys).",
    ],
  },
  {
    date: "2026-06-26",
    items: [
      "Copy and paste schematic components with Ctrl+C and Ctrl+V.",
      "The site has moved to dedicated, professional hosting (coming from being hosted on my old PC over my residential ISP)(I got really lucky that this site was up 100% over the last 4 months with this old setup).",
    ],
  },
  {
    date: "2026-06-22",
    items: [
      "Added this What's New page, so you can follow recent changes and what is planned.",
      "Added a feedback box. Send a message any time, and when logged in you can read replies and keep a conversation going right on the site.",
    ],
  },
  {
    date: "2026-06-16",
    items: [
      "Place cuts directly on a hole by holding Alt, in addition to cutting between holes.",
      "Confirmation prompt before deleting a custom component.",
      "Fixed selection and wire-drawing glitches near flexible 2-pin components.",
    ],
  },
  {
    date: "2026-06-04",
    items: [
      "Website and landing page redesign.",
    ],
  },
  {
    date: "2026-05-20",
    items: [
      "Printable 1:1 assembly guide with a mirrored copper-side cut sheet and a bill of materials (BOM).",
      "Redesigned and unified the built-in component library.",
    ],
  },
  {
    date: "2026-05-19",
    items: [
      "Separate value field for parts like resistors and capacitors.",
      "Project import is now validated and can be undone.",
    ],
  },
];

const planned: string[] = [
  "Net list import and export, aiming for compatibility with EDA tools like KiCad so you can move designs in and out of the editor.",
  "A big custom-component overhaul, including a searchable library of both your own and shared community components. Including a better custom component editor.",
  "Optional email address for password resets, so you can recover account access if you forget your password.",
];

export default function UpdatesPage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="whats_new" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">What&apos;s New</h1>

          {/* Recent updates */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-4">Recent updates</h2>
            <div className="space-y-6">
              {updates.map((u) => (
                <div key={u.date}>
                  <p className="text-xs font-mono text-neutral-400 dark:text-neutral-500 mb-1.5">{u.date}</p>
                  <ul className="list-disc list-inside space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
                    {u.items.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {/* Planned */}
          <section>
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Planned</h2>
            <ul className="list-disc list-inside space-y-3 text-sm text-neutral-700 dark:text-neutral-300">
              {planned.map((item, i) => (
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
