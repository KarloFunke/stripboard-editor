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

          <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">
            How Auto-layout Works
          </h1>

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
                two-pin parts such as resistors. It evaluates several arrangements per group and retains the tidiest, keeping to
                the spacing and clearance you allow for each part type.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">3. Arrange the groups.</span> The finished
                groups are packed onto the board as blocks, with different combinations tried to keep the overall footprint small.
                This stage also determines the board size, unless you have fixed one yourself.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">4. Cut and wire.</span> Once everything is
                placed, the router identifies every point where two nets would share a strip and inserts a cut to separate them,
                then routes link wires to join the pins that ended up on different strips. Cuts are placed the way a builder would
                make them: as a drilled-out hole rather than a scored gap, preferably under an IC body where the hole gives up
                nothing usable, and lined up in shared columns where possible so a whole run of cuts can be drilled along one
                straight line.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">5. Refine.</span> The router then improves
                the result: reclaiming empty space, removing redundant wires, and trimming blank rows and columns at the board
                edges. Each refinement is verified to still produce a working board before it is accepted.
              </li>
              <li>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">6. Straighten the wires.</span> A finished
                board that still has slanted or crossing wires gets a second pass. The router solves the same circuit again with
                the board width it just found held fixed, which frees it to spend space on wire channels instead of shaving area,
                and on IC-heavy circuits it may insert a spare row or column beside a chip to act as a channel for the wires that
                would otherwise cross it. The second result replaces the first only when it is strictly tidier and stays close to
                the original size, so this pass never costs you a messier board.
              </li>
            </ol>
          </section>

          {/* Scoring */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Choosing between options</h2>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
              Several of these stages produce multiple candidate layouts, each of which is scored. A layout rates better when it is
              smaller, uses fewer link wires, keeps wires vertical instead of slanted, and has fewer wires crossing over
              components or running on top of each other; the strongest candidates are carried forward. The scoring is fully
              deterministic, so a given circuit always yields the same layout.
            </p>
          </section>

          {/* What it respects */}
          <section className="mb-10">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">What you can control</h2>
            <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
              <li><strong>Board size.</strong> Lock the rows or columns using the padlock beside their field and the router holds exactly that dimension, so the result fits a board you already own.</li>
              <li><strong>Locked parts.</strong> Fix a part in a chosen position and the router designs the remaining layout around it rather than moving it.</li>
              <li><strong>Pin spacing and clearance.</strong> Open the settings with the gear beside the <em>Auto-layout</em> button to tune each flexible part type. <em>Pin spacing</em> sets how many holes a part may span from pin to pin, so you can force resistors to stand upright or stretch flat. <em>Clearance</em> is the air the router keeps around a body: the default leaves one free strip beside the part, and lowering it to 0 lets parts of that type sit directly side by side.</li>
              <li><strong>Straighter wires.</strong> The second pass from step 6 is the <em>Straighter wires</em> checkbox in the same settings panel. It is on by default; turning it off roughly halves the solve time and accepts whatever wiring the first pass produces.</li>
              <li><strong>Physical constraints.</strong> By default the router accounts for the space real parts occupy; it will, for example, leave a strip between two through-hole resistors instead of overlapping their bodies. The clearance setting above is what governs this, so you decide how tightly a given part type packs.</li>
            </ul>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mt-3">
              Locked parts remain the hardest case for the router. Everywhere else it is free to choose positions, but a fixed
              part forces the surrounding layout to conform to a spot it did not pick, so expect a locked run to come out somewhat
              larger or with a few more wires than an unconstrained one. This has improved a lot over time and keeps improving,
              but an unconstrained run will usually stay the tidier of the two.
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
