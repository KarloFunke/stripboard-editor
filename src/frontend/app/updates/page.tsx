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

const updates: { date: string; items: string[]; link?: { href: string; lead: string; text: string } }[] = [
  {
    date: "2026-07-23",
    items: [
      "Netlist export. Export a design to an EDA tool as a KiCad-compatible netlist (.net): components, values, pin numbers and nets all are included, so you can turn a stripboard prototype into a PCB without redesigning the Schematic in another tool.",
      "Auto-align polarity. Drop or move a 2-legged part like a resistor onto the board with its legs reversed and it flips itself 180 degrees automatically, so each pin lands on its correct net.",
      "Fixed rotating 2-legged components: parts spanning an even number of holes now rotate in place instead of slowly wandering across the board, and four rotations return to the exact starting position.",
      "Floating menu for schematic wires. Select a wire to delete just that segment or the whole wire in one go (or press Alt+Del for the whole wire). A whole wire is everything connected up to the component pins it runs between.",
      "New built-in component: a fuse.",
    ]
  },
  {
    date: "2026-07-17",
    items: [
      "Placed components now show their orientation on the stripboard: a pin-1 notch on ICs, and a flat-belly (TO-92 style) outline on 3-legged parts like transistors and voltage regulators.",
      "New built-in components: a potentiometer and trimmer, a push button, ESP32 dev boards (30, 36 and 38-pin) and the Arduino Nano.",
    ],
  },
  {
    date: "2026-07-16",
    items: [
      "New auto-layout router (alpha). Click Auto-layout and the program will try to find an good layout of all components. It works but please consider it the first version I felt comfortable releasing. I plan to further improve on it in the future.",
    ],
    link: {
      href: "/guide/auto-layout",
      lead: "If you are interested in how it works,",
      text: "here is a look under the hood.",
    },
  },
  {
    date: "2026-07-07",
    items: [
      "You can now reset your account's password by email by adding an optional recovery email to your account."
    ],
  },
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
  "Net list import, the other half of the KiCad compatibility: bring a circuit in from an EDA tool and lay it out on stripboard. Export is already available.",
  "A big custom-component overhaul, including a searchable library of both your own and shared community components. Including a better custom component editor.",
  "Off-board components: place parts next to the board (for example a panel-mounted switch) and wire them directly to it, even when they are not mounted on the stripboard itself.",
  "Placing a cut directly underneath a component, without having to move the part out of the way first.",
  "Smoother wire handling on the board: start a new wire from a hole that already has one, instead of having to remove the existing wire first.",
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
                  {u.link && (
                    <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1.5">
                      {u.link.lead}{" "}
                      <Link href={u.link.href} className="text-[var(--copper)] hover:underline">{u.link.text}</Link>
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
