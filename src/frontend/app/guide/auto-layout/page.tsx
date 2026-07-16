import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "How Auto-layout Works",
  description:
    "A plain-language look at how the Stripboard Editor's auto-layout router arranges components, cuts strips, and adds link wires to build a working board.",
  alternates: { canonical: "https://stripboard-editor.com/guide/auto-layout" },
};

export default function AutoLayoutGuidePage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="how_auto_layout_works" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <div className="mb-6">
            <Link href="/guide" className="text-xs font-mono text-[var(--copper)] hover:underline">&larr; Back to the guide</Link>
          </div>

          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-2 tracking-tight">
            How Auto-layout Works
          </h1>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 dark:text-neutral-500 mb-6">alpha</p>

          {/* Alpha caveat, up front */}
          <div className="mb-8 rounded-md border border-[var(--copper)]/40 bg-[var(--copper)]/5 px-4 py-3">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
              <strong className="text-[var(--copper)]">This is an alpha, not a finished tool.</strong> It is an early version of
              the auto-layouter with a great deal of work still ahead. It handles the circuits in my test set well, but on many
              boards you will still want to reposition a part or reroute a wire by hand. It is simply the first version I
              considered ready to release, and it will keep improving. If it produces a poor result, I would be glad to hear about
              it through the <Link href="/feedback" className="text-[var(--copper)] hover:underline">feedback box</Link>.
            </p>
          </div>

          {/* Intro */}
          <section className="mb-10">
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
              Pressing <strong>Auto-layout</strong> hands the circuit from your schematic to the router, which attempts to produce
              a complete stripboard: a position for every part, the set of strip cuts, and the link wires that finish the
              connections. This page outlines the approach it takes. None of it is required to use the feature, but it should make
              the results easier to read and to steer.
            </p>
          </section>

          {/* The problem */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">The problem it solves</h2>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mb-2">
              A stripboard is a grid of holes over continuous copper strips, where every hole on a strip is already electrically
              common with the rest. Realising a circuit on it comes down to three operations:
            </p>
            <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
              <li>Pins that share a net must sit on the <strong>same</strong> strip.</li>
              <li>Pins that belong to different nets must be separated by a <strong>cut</strong> across the strip.</li>
              <li>Connections a strip cannot carry are bridged by a <strong>link wire</strong> between two holes.</li>
            </ul>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mt-2">
              Even a modest circuit has an enormous number of valid arrangements, far too many to search exhaustively. The router
              instead proceeds in stages, constructing a reasonable layout and then refining it.
            </p>
          </section>

          {/* The steps */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-4">How it builds a layout</h2>
            <ol className="space-y-4 text-sm text-neutral-700 dark:text-neutral-300">
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">1. Group related parts.</span> The router
                examines the net connections and gathers strongly connected components into small groups, such as an IC with its
                surrounding resistors and capacitors. Placing these parts together keeps the final layout compact and reduces the
                number of wires.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">2. Lay out each group.</span> Within each
                group it fixes the orientation of every part, aligns the pins to strips, and sets the span of the flexible leads on
                two-pin parts such as resistors. It evaluates several arrangements per group and retains the tidiest, never
                allowing parts closer than they can physically sit.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">3. Arrange the groups.</span> The finished
                groups are packed onto the board as blocks, with different combinations tried to keep the overall footprint small.
                This stage also determines the board size, unless you have fixed one yourself.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">4. Cut and wire.</span> Once everything is
                placed, the router identifies every point where two nets would share a strip and inserts a cut to separate them,
                then routes link wires to join the pins that ended up on different strips.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">5. Refine.</span> Finally it improves the
                result: reclaiming empty space, removing redundant wires, and where possible keeping wires from crossing over
                components. Each refinement is verified to still produce a working board before it is accepted.
              </li>
            </ol>
          </section>

          {/* Scoring */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Choosing between options</h2>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
              Several of these stages produce multiple candidate layouts, each of which is scored. A layout rates better when it is
              smaller, uses fewer link wires, and has fewer wires crossing over components; the strongest candidates are carried
              forward. The scoring is fully deterministic, so a given circuit always yields the same layout.
            </p>
          </section>

          {/* What it respects */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">What you can control</h2>
            <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
              <li><strong>Board size.</strong> Lock the rows or columns using the padlock beside their field and the router holds exactly that dimension, so the result fits a board you already own.</li>
              <li><strong>Locked parts.</strong> Fix a part in a chosen position and the router designs the remaining layout around it rather than moving it.</li>
              <li><strong>Physical constraints.</strong> The router always accounts for the space real parts occupy; it will, for example, leave the necessary gap between two through-hole resistors instead of overlapping their bodies.</li>
            </ul>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mt-3">
              Locked parts are the hardest case for the router. Everywhere else it is free to choose positions, but a fixed part
              forces the surrounding layout to conform to a spot it did not pick, which can enlarge the board or add wires compared
              with an unconstrained run. It usually still reaches a working result, but this is the roughest area of the router
              today and the one I most expect to improve in future versions.
            </p>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mt-3">
              Refer to the <Link href="/guide" className="text-[var(--copper)] hover:underline">quick guide</Link> for the exact
              keys and buttons.
            </p>
          </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
