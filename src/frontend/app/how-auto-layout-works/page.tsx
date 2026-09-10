import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import AnnealDemo from "./figures/AnnealDemo";
import SequencePairDemo from "./figures/SequencePairDemo";
import StepLinesDemo from "./figures/StepLinesDemo";
import DecodeStage from "./figures/walk/DecodeWalk";
import MoveDemo from "./figures/walk/MoveDemo";
import MiniRun from "./figures/walk/MiniRun";
import FinishWalk from "./figures/walk/FinishWalk";
import ExampleGenome from "./figures/walk/ExampleGenome";
import EnergyTrace from "./figures/EnergyTrace";
import LandscapeValley from "./figures/LandscapeValley";
import { AcceptanceChart, LandscapeSketch } from "./figures/StaticFigures";

export const metadata: Metadata = {
  title: "How Auto-layout Works",
  description:
    "How the Stripboard Editor's automatic layouter works, explained for the curious: what simulated annealing is, what a problem needs so it can be annealed, and how a stripboard is described, scored, searched and finished.",
  alternates: { canonical: "https://stripboard-editor.com/how-auto-layout-works" },
};

const H2 = ({ id, children }: { id: string; children: ReactNode }) => (
  <h2 id={id} className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3 mt-12 first:mt-0 scroll-mt-20">{children}</h2>
);
const H3 = ({ children }: { children: ReactNode }) => (
  <h3 className="font-mono text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-7 mb-2">{children}</h3>
);
const P = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mb-3">{children}</p>
);
const UL = ({ children }: { children: ReactNode }) => (
  <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300 mb-3 list-disc pl-5">{children}</ul>
);

const TOC: [string, string][] = [
  ["annealing", "1. Annealing, by example"],
  ["requirements", "2. What it takes to anneal well"],
  ["goal", "3. What a good board looks like"],
  ["description", "4. Describing a board without coordinates"],
  ["moves", "5. The moves"],
  ["decoding", "6. From description to board"],
  ["score", "7. The score"],
  ["search", "8. The run"],
  ["finish", "9. Finishing the board"],
  ["portfolio", "10. Many runs"],
  ["limits", "11. What it cannot do"],
  ["results", "12. How well it works"],
  ["notes", "Final notes and references"],
  ["related", "Appendix A: Related work"],
];

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

          <P>
            Even a modest circuit has an enormous number of valid stripboard arrangements. Ten components alone can be ordered and rotated
            in nearly four trillion ways. Trying them one by one is out of the question, and there is no formula
            that produces the best one directly ( yet :) ).
          </P>
          <P>
            So the layouter searches. It describes a board in a compact form, scores it, changes the description a little, scores
            it again, and repeats this hundreds of thousands of times slowly creating a better and better layout.
            The method is called simulated annealing, after the way slowly cooled metal settles into an orderly crystal, and it is
            the heart of the whole thing.
          </P>
          <P>
            This page explains how the algorithm used by this website works.
            First what annealing is, by demonstrating it on a simplified version of the problem. Then
            what a problem needs so that annealing works on it. Then what a good board is, how a stripboard layout is written down and changed, how the
            written form turns back into a board and a score, and how a run is put together and finished. It assumes an interest in how things work and nothing else.
          </P>
          <details id="stripboard" className="my-6 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 px-3 py-2 [&[open]]:pb-3">
            <summary className="cursor-pointer text-xs font-mono text-[var(--copper)] hover:underline marker:text-neutral-400">
              0. What is stripboard? (if you somehow ended up on a website that lays out stripboard but don&apos;t know what it is, please read this)
            </summary>
            <div className="mt-3">
              <P>
                Stripboard, also called veroboard, is a sheet of insulating board drilled with a grid of holes a tenth of an inch apart, with parallel
                strips of copper glued to the back, one strip per row of holes. Every hole in a row is already connected to
                every other hole in that row. Nothing else is connected to anything.
              </P>
              <figure className="my-4">
                <img src="/bare-stripboard.png" alt="A bare piece of stripboard: a grid of holes with continuous copper strips running along each row" width={1347} height={705} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
                <img src="/bare-stripboard-dark.png" alt="A bare piece of stripboard: a grid of holes with continuous copper strips running along each row, dark mode" width={1347} height={705} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
                <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
                  A bare board. Each row of holes is one continuous strip of copper, so anything soldered into the same row is
                  joined whether you meant it or not.
                </figcaption>
              </figure>
              <P>
                Building on it means pushing component legs through holes and soldering them to the copper underneath. Two legs
                in the same row are connected, which is how you make a connection and also how you make a mistake. So the board
                is shaped in two more ways. Where one strip would join two things that must stay apart, the copper is broken
                by drilling the copper away at a spare hole or cutting it with a knife. Where two rows must
                be joined, a short piece of wire is soldered from a hole in one row to a hole in the other, which is called a
                link wire.
              </P>
              <P>
                So a stripboard layout is three decisions at once: where each component sits, where the strips are cut, and
                where the link wires run. They depend on each other, and doing them by hand is a puzzle.
              </P>
            </div>
          </details>
          <nav className="my-6 rounded border border-neutral-200 dark:border-neutral-700 p-3 text-xs">
            <ol className="space-y-1">
              {TOC.map(([id, label]) => (
                <li key={id}><a href={`#${id}`} className="text-[var(--copper)] hover:underline">{label}</a></li>
              ))}
            </ol>
          </nav>

          {/* 1 */}
          <H2 id="annealing">1. Annealing, by example</H2>
          <P>
            Start with a much smaller problem that has the same flavour as a stripboard. Eight blocks of different sizes have to be
            placed on a small grid. Some pairs of blocks are connected by wires. A placement is good when the blocks sit in a small
            rectangle and the connections are short, so its score is the area of the rectangle around all blocks plus one and a
            half times the total connection wire length. Lower is better. Blocks may not overlap and may not leave the grid.
          </P>
          <H3>Only ever improving</H3>
          <P>
            The most obvious search is this: take the current placement, change it a little (shift one block by one cell, or
            swap two blocks), and keep the change if the score got better or stayed the same, otherwise throw it away. Repeat.
            Press play below and watch what happens.
          </P>
          <AnnealDemo mode="greedy" fixedMode seed={8} steps={1500} caption="Improvements only. Each step proposes one small change. Green: better, kept. Red: worse, rejected. Grey: not a valid placement. The dashed rectangle is the area being scored, the chart shows the score over the run." />
          <P>
            It improves quickly at first and then stops dead, usually well short of the best possible placement. The reason is
            easy to see once it has frozen: every single small change makes the score worse, so nothing is ever accepted again,
            even though a few changes in a row would lead somewhere much better. Two blocks may need to trade places through a
            temporarily wider board, or a block has to make room for another before it can move itself. The search is stuck in what
            is called a local minimum: a placement better than all its neighbours, but not the best overall. Press New start a few
            times and you will see it freeze in a different place with a different score each time.
          </P>
          <H3>Accepting the occasional setback</H3>
          <P>
            Simulated annealing changes exactly one thing about this rule. A change that makes the score worse is not always
            rejected. It is kept with a probability that depends on two numbers: how much worse it makes the score, and a control
            value called the temperature. Small setbacks are kept often, large ones rarely, and the temperature scales what counts
            as small. At a high temperature almost anything is kept and the search wanders freely. At a low temperature only tiny
            setbacks pass and the search behaves like the improvements-only rule. The run starts hot and cools slowly.
          </P>
          <AcceptanceChart />
          <P>
            Here is the same problem, from the same starting placement, with that one change. Early in
            the run the search happily makes the board worse, and the score chart is a jagged mess. As the temperature falls the
            "bad" moves get accepted less often, the chart calms down, and the search settles on one arrangement and polishes
            it. The green line is the best placement seen so far, which is what a run returns at the end.
          </P>
          <AnnealDemo mode="anneal" seed={8} steps={3000} caption="Annealing from the same start. Orange: worse, kept anyway. The dashed orange line is the temperature falling from 6 to 0.5 over the run. Try the shortest run: cooled four times faster it usually ends a little worse, and the longest run a little better. Switch the mode to compare with improvements only from the same start." />
          <P>
            Why does this work? Early in the run a setback costs almost nothing, so the search climbs straight back out of the
            local minima that trapped the improvements-only rule, and it keeps moving between placements that are quite unlike
            each other. Improvements are still always kept, so the wandering is not aimless: it spends its time where good
            placements are common. As the temperature falls the larger setbacks stop passing, the search can no longer leave the
            arrangement it has arrived at, and the rest of the run goes into refining that one. If the cooling is slow enough,
            what it commits to is very likely one of the good arrangements. Cool too fast and it commits early, to whatever it
            happened to be holding. Cool forever and it finds the best placement there is, which is a theorem and also useless,
            because forever is a long time. Real runs choose a length and accept that they end at a good placement rather than
            the best one.
          </P>
          <P>
            The name comes from metallurgy. Metal that is cooled quickly ends up with its atoms frozen in a disordered jumble, full
            of internal stress. Metal that is heated and then cooled slowly gives the atoms time to find their way into an orderly
            crystal, the arrangement of lowest energy. Annealing is the slow cooling, and the search borrows the word, the
            temperature and even the formula for how often a setback is accepted.
          </P>
          <P>
            The method has nothing to do with circuit boards in particular, and can be used to tackle 
            a whole lot of different problems. My own first contact with it was a fantastic video by AlphaPhoenix I saw a few years ago,{" "}
            <a href="https://www.youtube.com/watch?v=Lq-Y7crQo44" target="_blank" rel="noopener noreferrer" className="text-[var(--copper)] hover:underline">
              drawing congressional district maps of North Carolina
            </a>
            , gerrymandered or fair as you please. Same concept. If you want to see another 
            fascinating and very entertaining use case of simulated annealing, I highly recommend you watch that video.
          </P>

          {/* 2 */}
          <H2 id="requirements">2. What it takes to anneal well</H2>
          <P>
            Annealing is a general idea, but it only works well on a problem that has been prepared for it. Four things have to be
            true, and most of the engineering in the layouter is about making them true for stripboards.
          </P>
          <H3>Scoring must be very fast</H3>
          <P>
            A run makes a great many proposals and every one has to be scored. In the toy above a score is a few simple
            additions, incredibly fast on a modern processor. For a stripboard, the scoring is much more complicated and it will include
            more than calculating the area of the board.
            The layouter needs a way to score a board in a fraction of a millisecond.
          </P>
          <H3>Small changes must mostly cause small score changes</H3>
          <P>
            Annealing walks through neighbouring states. That only helps if neighbours usually have similar scores, so that a step
            in a good direction is recognisable as such. Picture the score as a landscape over all possible states. Annealing
            copes well with a landscape of broad valleys and ridges. It copes badly with one that looks like a saw blade, where the
            state next door is as likely to be terrible as excellent, because then no step carries information about where to go.
          </P>
          <LandscapeSketch />
          <P>
            Sadly few real problems can be written down so that they turn into the rolling hills on the left, and stripboards are
            not among them (as far as I know as of writing this anyway). But luckily it turns out they do not have to be. A landscape anneals well as long as it has structure of the
            right kind, picture a river valley: steep walls on most sides, but between the walls a floor
            that keeps going downhill. A hot search crosses the walls freely and stumbles into different valleys. 
            A cooling one is caught by one valley, and once it is in that valley it can follow the valley downstream. 
            Such a landscape takes more effort to walk than rolling hills, since most
            directions from any point are walls and the annealer cannot see the channel, it has to blindly try moves slowly stumbling downhill. But it anneals.
          </P>
          <LandscapeValley caption="What most real problems offer at best: walls on most sides, and channels between them that run downhill. A search that finds a channel can follow it a long way down." />
          <H3>The description must rule out nonsense, or price it</H3>
          <P>
            The toy rejects overlapping placements outright, which is fine for eight blocks where most moves are valid. For a real
            board that would waste most of the run on rejected proposals. Better is a description in which every possible value is
            a real, overlap-free board, so no proposal is ever wasted.
          </P>
          <H3>The description must be able to express the good boards</H3>
          <P>
            The search can only ever find boards that its description can write down. That sounds obvious, but as
            a description gets smaller and safer it sometimes cannot say certain
            things. Every board it cannot say is a board the search will never see, however long it runs. If the best board needs a
            resistor placed horizontally and the description only knows vertical resistors, the run can never find it.
            So the description has to be able to express every arrangement worth finding while still
            ruling out nonsense.
          </P>

          {/* 3 */}
          <H2 id="goal">3. What a good board looks like</H2>
          <P>
            Before the search itself, a word on what it searches for. A stripboard layout is good when a person is happy to
            build it. I consider the following properties most relevant:
          </P>
          <UL>
            <li><strong>Complete.</strong> Every connection of the schematic made, nothing else connected, no two components colliding or closer than the clearance asked for.</li>
            <li><strong>Small</strong>, and rather wide than tall but optimally squarish.</li>
            <li><strong>Few link wires</strong>, and short ones.</li>
            <li><strong>Few cuts</strong>, preferably drilled.</li>
            <li><strong>Connectors on an edge.</strong></li>
            <li><strong>Clean wires.</strong> Every link wire straight along one column or a spare strip, crossing no component and no other wire.</li>
          </UL>
          <H3>Wire mess</H3>
          <P>
            A huge portion of the effort has gone into fighting this. 
            Wires that are off axis (also referred to as slanted in this text) or cross a component 
            create visual mess and make it much harder to solder up a result.
            The pictures below demonstrate it. Both are the same circuit, laid out automatically:
          </P>
          <figure className="my-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <img src="/wire-mess.png" alt="The guitar pedal benchmark circuit laid out by an older, simpler layouter: several slanted link wires and two crossings" width={904} height={777} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
              <img src="/wire-mess-dark.png" alt="The guitar pedal benchmark circuit laid out by an older, simpler layouter: several slanted link wires and two crossings" width={904} height={777} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            </div>
            <div>
              <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark).png" alt="The same circuit laid out by the current layouter: every link wire straight along a column, no crossings" width={846} height={777} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
              <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)-dark.png" alt="The same circuit laid out by the current layouter: every link wire straight along a column, no crossings" width={846} height={777} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            </div>
            <figcaption className="sm:col-span-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
              Left, an early version of the layouter: slanted wires, wires crossing each other and running over components. Right,
              the current one on the same circuit: every link wire runs straight along a column and crosses nothing. Both
              boards work electrically. Only one of them is a board you would want to build (unless you&apos;re a maniac).
            </figcaption>
          </figure>

          {/* 4 */}
          <H2 id="description">4. Describing a board without coordinates</H2>
          <P>
            Section 2 asked for a description in which a small change has a small effect. Writing a
            board down as a list of coordinates (this component at row 4 and column 7, that one at row 9 and column 2) at first
            look sounds good. It is not, because a component on a stripboard is not defined by where it sits but by which strips its pins touch.
            Move it one row and every one of its pins lands on a different strip: nets that shared a strip are torn apart, other
            nets are suddenly shorted together, the cuts and wires belong somewhere else. The
            board after such a step has little in common with the board before it, and its score is a fresh draw rather than a
            small change. That is the saw blade.
          </P>
          <P>
            This section describes the alternative the layouter uses instead: a way of writing a board down in which
            every value is a board, every good board can still be expressed, and the landscape resembles the 
            river valleys instead of a saw blade.
          </P>
          <P>
            To achieve this the layouter never records where a component is. 
            Instead it records how the components relate to each other, and lets the positions
            follow from that. The core of the description is a pair of orderings: two lists of component names.
          </P>
          <H3>Reading a packing into two orders</H3>
          <P>
            Start from a finished packing of rectangles and read it in a peculiar way. For each component, draw a line: from its
            lower-left corner walk down to the bottom of the board, and whenever another component is in the way, slide left along that
            component&apos;s top edge until you can go down again; from its upper-right corner walk up to the top the same way, sliding
            right along the bottom edge of anything in the way. Join the two halves through the component. Because these lines all
            climb from lower-left to upper-right and slide around obstacles in the same direction, no two of them ever cross, and
            that means they can be read from left to right. Their left-to-right order is the first order of the components. Now draw
            the mirror image, lines that climb from lower-right to upper-left, and read those from left to right too: that is the
            second order. Press play to watch the lines being drawn one by one.
          </P>
          <StepLinesDemo />
          <P>
            The two orders are the whole description of the packing. Take any two components, A and B. If A comes before B in both
            orders, A is left of B. If A comes before B in the first order but after B in the second, A is above B. Hover a component
            in the figure and check it against the drawing. Every pair of components gets exactly one of the four relations left,
            right, above, below, and because they were read off a real packing they are consistent with each other.
          </P>
          <H3>And back: from two orders to a packing</H3>
          <P>
            The trick is that this also works the other way round, from any two orders at all. Write the components down in some
            order, then again in another order, apply the rule above to every pair, and push each component as far up and as far left
            as its relations allow. The result is a packing with no overlaps, whatever the two orders were. Try it: swap entries
            and watch the packing follow.
          </P>
          <SequencePairDemo />
          <P>
            This pair of orders is a classic trick from chip floorplanning, where it was introduced by Murata and colleagues in
            1995 under the name sequence pair. Its virtues are exactly the four requirements from section 2. Turning two orders
            into positions is a short computation, so scoring stays fast. Swapping two entries is a small change that usually
            produces a small change in the packing. Every pair of orders
            is a valid packing, so no move is wasted on nonsense. And every compact packing can be written as a pair of orders,
            so nothing good is out of reach.
          </P>
          <H3>The rest of the description</H3>
          <P>
            Unfortunately a stripboard needs more than a packing of rectangles. Stripboard has a useful property: once the components are placed,
            almost everything else is forced. Which strips carry which nets, where the cuts have to go and which segments need a
            link wire all follow from the pin positions. But that also means the
            packing alone decides the electrical quality of the board, and a packing of bare rectangles knows nothing about it.
            Two pins of one net land on the same strip or on different strips by accident, and a small change to the packing can
            turn one into the other and one link wire into three. That is the jagged landscape of section 2 again, and the two
            orders alone do not fix it. Their real strength is that they can be combined with further entries. The electrical
            choices then stop being accidents of the packing and become explicit parts of the description.
          </P>
          <P>Here are the other descriptions used alongside the 2 orderings:</P>
          <UL>
            <li><strong>Rotation</strong> of every rigid component, in four steps.</li>
            <li><strong>Flat or upright</strong> for every two-legged component with flexible leads, such as a resistor or a diode, and <strong>how far its leads span</strong>, within the range you allow in the settings.</li>
            <li><strong>Which end goes where</strong> for those components, since a resistor can be turned around.</li>
            <li><strong>Strip groups.</strong> For every net, which of its pins are asked to share one copper strip. Pins in the same group are forced onto the same row during the construction of the board from this description; pins in different groups get their own rows and are joined by a link wire later.</li>
            <li><strong>Reserved blank lines.</strong> A component can ask for a blank row below it or a blank column beside it. Those are the rows and columns the wiring will use, and reserving them in the description lets the annealer trade area against wiring room.</li>
          </UL>
          <P>
            Together this is a description made of a few hundred small choices for a typical circuit, and any combination of
            choices is a board. That is the state the annealer walks through.
          </P>
          <H3>The example used from here on</H3>
          <P>
            To make that concrete, here is one complete description, the one the next sections work with. The circuit is a
            555 timer blinking a load: the timer in its one-resistor astable form, a capacitor and a resistor setting the pace,
            a second resistor feeding a transistor that switches whatever hangs on the connector. Six components, six nets.
          </P>
          <figure className="my-6">
            <img src="/annealer-demo-schematic.png" alt="Schematic of the example circuit: a 555 timer in the single-resistor astable form driving an NPN transistor that switches a load on a three-pin connector" width={1339} height={811} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
            <img src="/annealer-demo-schematic-dark.png" alt="Schematic of the example circuit, dark mode" width={1339} height={811} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
              The example circuit as drawn in the editor. A single resistor from the output back to the timing pins makes the
              555 oscillate, and the transistor switches the load on the connector.
            </figcaption>
          </figure>
          <P>
            Below is everything the annealer knows about the board: two orders, the rotation of the rigid components, the choices
            for the flexible ones, the strip groups and the reserved blank lines.
          </P>
          <ExampleGenome />

          {/* 5 */}
          <H2 id="moves">5. The moves</H2>
          <P>
            The description is settled, so the next question is what a step of the search looks like. In section 1 a step
            nudged a block by one cell. Here a step edits the description: it changes one or two of its entries.
            Each step proposes one of these changes, chosen at random with fixed odds:
          </P>
          <UL>
            <li>Swap two nearby entries in the first order, in the second, or in both.</li>
            <li>Pull a component next to another component of the same net, in both orders at once.</li>
            <li>Flip a flexible component between flat and upright, turn it around, or change how far its leads span.</li>
            <li>Merge two strip groups of a net, or split a pin off into a group of its own.</li>
            <li>Open or close a reserved blank row or column beside a component.</li>
            <li>Rotate a rigid component by a quarter turn.</li>
            <li>Throw a connector to the far end of both orders, so it can reach the opposite board edge.</li>
          </UL>
          <P>
            Try them on the example. Each button proposes one random change of that kind and marks what changed in the
            description. The two boards are what the description stood for before and after: how the layouter gets from the
            description to a board is the subject of the next section, so for now take them as given. Keep a change or undo it, as
            the annealer does at every step.
          </P>
          <P>
            Be warned that most buttons will make the score jump by several hundred points (But there is at least one good move to discover : ) ). 
            That is the consequence of the landscape. 
            A change that leaves a pin without a free hole for its wire, or lays a wire across a component, is
            priced far above any saving in area. Most single edits of a decent description do exactly that. Those are the steep walls
            at the edges of the river valleys. Finding the few moves that travel down the river valley is what the annealer is spending its time on 
            in the ending phase of each run. While at the start it accepts those big jumps in the score to find a valley to settle into.
          </P>
          <MoveDemo caption="One move at a time, with mess priced as at the end of a run. The changed entries of the description are marked." />
          <P>
            One thing the demo quietly assumes is the whole problem of the next section. A move changes an entry or two of
            the description, and the annealer has to judge whether the board got better. But the description has no area,
            no wires and no cuts; it is far too abstract to score. So every single step, the description has to be turned back into a board
            first, so that it can be measured.
          </P>

          {/* 6 */}
          <H2 id="decoding">6. From description to board</H2>
          <P>
            Decoding turns a description into positions, strips, cuts and wires by the rules of section 4 and
            some bookkeeping. It has to come close to the finished board, since a score based on a rough guess might
            lead the search into a wrong direction. It is also the most time-critical piece of the
            layouter, because it runs once per step, so wherever a small simplification buys a large speedup that trade is
            worth it. For example the last refinement of cuts and wires is left to the finishing pass of section 9 while 
            this decoder only gets close to that.
          </P>
          <P>
            The figures below are recordings of the layouter&apos;s own decoder at work on the example description from the
            end of section 4. Use the arrows, or press
            play.
          </P>
          <H3>Relations</H3>
          <P>
            First the two orders become relations. For every pair of components: before in both orders means left of, before in the
            first order and after in the second means above.
          </P>
          <DecodeStage stage={1} caption="The six components in their two orders, and the relation each pair gets. Fifteen relations." />
          <H3>Building rows from the relations</H3>
          <P>
            Rows come first, because the strips run along the rows: which row a pin lands on is the electrical decision, and
            the columns only decide how much space lies between. Every above-relation becomes an arrow from the upper component
            to the lower one that says at least so many rows apart, the upper component&apos;s height plus the clearance between
            them. Pins that a strip group asks to share a strip tie their components together at a fixed distance, so from then on
            they move as one. Then the arrows are checked one after the other, in the sequence of the first order, and every
            arrow that does not hold pushes its target down. After a few sweeps nothing moves any more, and those are the
            rows.
          </P>
          <P>
            Sometimes the ties and the arrows ask for the impossible: the orders put one component above another, but a strip
            group wants pins of the two on the same strip. In this case the decoder
            splits one pin out of its strip group, writes that back into the description so the annealer state gets it as well, and
            starts the row solve over. The pin gets a link wire later instead.
          </P>
          <DecodeStage stage={2} caption="The row solve. One lane per component in the sequence of the first order, the vertical axis is the row. Amber: the arrow being applied. Dashed lines: pins tied to one strip. Red: a contradiction." />
          <H3>Columns</H3>
          <P>
            With the rows known the components can be drawn. Each left-of relation is now an arrow on the board, at least the left
            component&apos;s width plus the gap further right.
          </P>
          <DecodeStage stage={3} caption="Components start in column 0 and are pushed right until every arrow holds. The board is as tight as the relations allow." />
          <H3>Strips, cuts and bus rows</H3>
          <P>
            Now the board is a grid: one blank line of margin on each side, a copper strip on every row. Each row is read
            from left to right. Where pins of two different nets sit on one strip, a cut goes between them, drilled through a
            spare hole if there is one and knife-cut between two holes if there is not. What remains are strip segments, each
            carrying one net. Rows with no pins at all are bus rows, spare copper any net may borrow to travel sideways.
          </P>
          <DecodeStage stage={4} caption="Reading the strips. The dashed row is the one being read, the blue bands are bus rows, and every X is a cut." />
          <H3>Link wires</H3>
          <P>
            Finally every net whose pins ended up on more than one segment is joined up. For two segments the decoder looks
            for a column with a free hole on both, which gives a straight vertical wire; green rings mark holes that would
            do, red rings holes that are taken or would put the wire over a component. Where no such column exists it looks for a
            relay: a hop to a bus row, a hop back. Only when neither exists does it record a
            slanted wire, and charge for it.
          </P>
          <DecodeStage stage={5} caption="Joining the nets. Watch the one that finds no free column and takes the detour over a bus row: two straight wires and a stretch of borrowed copper, where a slanted wire would have been." />
          <P>
            All of that, for a board of forty components, takes the decoder about a tenth of a millisecond.
            What the figures leave out is only the finishing pass of
            section 9, which turns the decoder&apos;s board into the one you get.
          </P>

          {/* 7 */}
          <H2 id="score">7. The score</H2>
          <P>
            The score of a decoded board is a weighted sum. The weights were tuned by running the layouter over many 
            boards and adjusting them until further adjustments didn&apos;t improve the results anymore 
            (kind of like annealing the annealer) (This took many many hours of my CPU annealing boards). The exact numbers matter less
            than the order of magnitude between the terms.
          </P>
          <UL>
            <li><strong>Area</strong> of the board, about a third of a point per cell.</li>
            <li><strong>Shape.</strong> Rows beyond the width are charged extra; a ribbon more than twice as wide as tall is charged too.</li>
            <li><strong>Link wires</strong>, a few points each plus a little per unit of length. Cuts are almost free; a knife cut between two holes costs more than a drilled one, and much more when you have asked for drilled cuts only.</li>
            <li><strong>Connectors</strong> that are not on a board edge, so that plugs end up where an external wire can reach them.</li>
            <li><strong>Wire mess</strong> as defined in section 3, priced mildly at the start of the run and prohibitively at the end. Forbidding it from the first step would leave the search nowhere to go, because every rough early arrangement is messy. So the coarse arrangement is allowed to form first, and then the price rises until no such wire survives.</li>
            <li><strong>Unreachable pins</strong>, at a price no saving in area can pay for.</li>
          </UL>
          <DecodeStage stage={6} caption="What the annealer gets back for the board of section 6: one number." />

          {/* 8 */}
          <H2 id="search">8. The run</H2>
          <P>
            Everything is in place now: a description that anneals well, moves that edit it, a decoder that turns it into a
            board and a score that judges the board. What remains is the schedule of the run itself.
          </P>
          <H3>The schedule</H3>
          <P>
            The temperature falls geometrically from 150 to 0.15 over the run (the toy in section 1 ran from 6 to 0.5; a real
            board&apos;s scores are much larger numbers, so its temperatures are too), and the price of a slanted or crossing wire rises
            geometrically from 25 to 400 over the same run. Here is what a real run looks like:
          </P>
          <EnergyTrace />
          <H3>The whole thing, small</H3>
          <P>
            Here is everything from sections 4 to 8 in one place: a random description of the example, the moves of section
            5, the decoder of section 6 and the score of section 7, a falling temperature and a rising price of mess. It is
            the layouter&apos;s own loop, run on the example for a few thousand steps and replayed. Press play and watch a board
            appear.
          </P>
          <MiniRun seed={1} steps={10000} caption="A full run on the example. Early on the board is a mess and the annealer does not care; as the price of mess rises the wires straighten, and as the temperature falls the board packs. Finished runs show the best board found, scored at the full price." />

          {/* 9 */}
          <H2 id="finish">9. Finishing the board</H2>
          <P>
            The annealer returns a description. Its decoded board is already complete in principle, but the decoder is a fast
            approximation of the editor&apos;s final router, so the best few descriptions of a run are handed to that router for the
            final cleanup.
          </P>
          <P>
            It enforces a few additional things: on an unlocked board, every link wire runs straight along a column or a
            spare strip, no wire runs over a component, and no wire crosses another. Here is the finish at work, on a run of
            the example like the one in section 8.
          </P>
          <FinishWalk caption="The finishing pass, stage by stage. Watch the board buy a column to straighten a wire and give it back once the router has found a tighter arrangement." />
          <P>
            Under a locked row or column count the board cannot grow, so this stage does what it can within the limit. 
            Locked components are treated the same way: nothing may shift.
          </P>

          {/* 10 */}
          <H2 id="portfolio">10. Many runs</H2>
          <P>
            A run ends where its channel took it, and a different random start means a different channel. Nothing marks the
            one a run found as the deepest there was, so the layouter does not make one run. It tries several in parallel, from
            different starts, and keeps the best board of the lot.
          </P>
          <LandscapeValley seed={3} runs={6} caption="Six runs on the landscape of section 2. Each ball is where one run froze, at the bottom of whichever channel it happened to find. They end at quite different depths, and the copper one, the deepest, is the board you would be given." />
          <P>
            The Layouts to solve setting says how many. The runs are spread over the processor cores of your machine,
            one run per core in use. The finished
            boards are compared on completeness first (for the very rare cases where a run wasn&apos;t able to complete a board), 
            then on a rating of area, wires
            and cuts. Every run uses a fixed random seed, so the same circuit with the same settings on the same machine
            gives the same board again; a setting starts every run from fresh random arrangements instead, for when you
            want to see more alternatives.
          </P>

          {/* 11 */}
          <H2 id="limits">11. What it cannot do</H2>
          <UL>
            <li><strong>Locked boards and locked components.</strong> Expect a run containing locked pieces or dimensions to be somewhat larger, or to keep a few slanted wires. It takes away some freedom from the solver.</li>
            <li><strong>Time.</strong> A small circuit is done in seconds; a big one uses the default minute it is given, depending on exact size it would probably still improve with more time (which you can adjust in the settings).</li>
            <li><strong>Taste.</strong> The score encodes some basic properties like size, wire length and count. It does not know that you wanted the LEDs in a row. Place those components yourself, lock them, and let it arrange the rest around them.</li>
          </UL>

          {/* 12 */}
          <H2 id="results">12. How well it works</H2>
          <P>
            The layouter is measured against a corpus of 271 circuits that people laid out by hand in this editor, from three
            components up to about fifty. On every one of them, unlocked, it produces a complete board with no slanted wire and
            no wire crossing a component, at the default of one minute per layout. Its board is smaller than the hand layout in
            199 cases, larger in 70 and the same size in 2, smaller by 30% on the median.
          </P>
          <P>
            The margin is largest on small boards and narrows as they grow. Up to twenty components the layouter beats most
            hand layouts on size and on wires; between twenty and forty it is a little smaller but spends more link wires;
            beyond forty the hand layouts often are still a bit tighter, this is where the work continues.
          </P>
          <P>
            Refer to the <Link href="/guide" className="text-[var(--copper)] hover:underline">quick guide</Link> for the buttons
            and settings. If you build something with it, or it does something odd, the{" "}
            <Link href="/feedback" className="text-[var(--copper)] hover:underline">feedback page</Link> is the place to contact me if you like.
          </P>
          <H2 id="notes">Final notes and references</H2>
          <P>
            Thank you for reading this far. I hope you found it interesting!
          </P>
          <P>
            This page describes a layouter that is work in progress. It is the current version, it changes as I find better
            ideas, and the numbers above are the state at the time of writing. Most of the ideas in it are not mine. Simulated
            annealing, the sequence pair, solving spacing constraints as a longest path and spanning trees for wiring are all
            well-known tools from other fields. What is new here is applying them to
            stripboards: the description that has the four properties of section 2, a decoder fast enough to make it work in a
            browser, and a score that matches what people build by hand. The sources I leaned on most:
          </P>
          <ol className="list-decimal pl-5 space-y-2 text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed mb-3">
            <li>S. Kirkpatrick, C. D. Gelatt Jr. and M. P. Vecchi, &ldquo;Optimization by simulated annealing&rdquo;, Science 220, 1983. The method introduced in section 1 and used in 8.</li>
            <li>H. Murata, K. Fujiyoshi, S. Nakatake and Y. Kajitani, &ldquo;VLSI module placement based on rectangle-packing by the sequence-pair&rdquo;, IEEE Transactions on Computer-Aided Design 15, 1996, first presented at ICCAD 1995. The two orders and the step-lines of section 4.</li>
            <li>T. H. Cormen, C. E. Leiserson, R. L. Rivest and C. Stein, Introduction to Algorithms, chapter on single-source shortest paths, section on difference constraints. Turning the relations into positions in section 6: the spacing rules are difference constraints, and the Bellman-Ford algorithm solves them as a longest path.</li>
            <li>R. C. Prim, &ldquo;Shortest connection networks and some generalizations&rdquo;, Bell System Technical Journal 36, 1957. The spanning tree that joins the segments of a net in section 6 and 9.</li>
          </ol>
          <H2 id="related">Appendix A: Related work</H2>
          <P>
            Surprisingly little has been published on this problem. Printed circuit board tools place components and then draw
            tracks wherever they like on an empty copper plane, and chip floorplanning, where the sequence pair comes from,
            packs rectangles and measures wire length. A stripboard is neither: the copper is already there, in one direction
            only, and the question is where to break it. What follows is everything I have found that tackles some part of it.
          </P>
          <P>
            The only published finished attempt at placing components automatically is a 2025 paper by Fang Li, 
            <a href="https://arxiv.org/abs/2512.04910" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Declarative Synthesis and Multi-Objective Optimization of Stripboard
            Circuit Layouts Using Answer Set Programming</a>. It writes the placement rules down as logical constraints, hands them
            to a general constraint solver, and asks it first for any layout that satisfies them and then for the one that keeps
            the pins of each component on nearby strips on the smallest board. It comes with five benchmark circuits.
            Strip cuts and link wires are
            not part of that model, which is why in its layouts every net needs a strip of its own; the paper names both as
            future work. The layouter on this site solves that same guitar pedal circuit in a few seconds. The project is public, so you can{" "}
            <a href="https://stripboard-editor.com/view/96fe339f-9d00-45e3-8417-85f876e2d610" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">open it in the viewer</a>:
          </P>
          <figure className="my-6">
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)schematic.png" alt="Schematic of the guitar pedal benchmark circuit from arXiv 2512.04910 as drawn in the Stripboard Editor" width={1992} height={1122} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)schematic-dark.png" alt="Schematic of the guitar pedal benchmark circuit from arXiv 2512.04910 as drawn in the Stripboard Editor, dark mode" width={1992} height={1122} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
              The guitar pedal benchmark circuit from Li&apos;s paper, as drawn in the editor: 18 components and 12 nets.
            </figcaption>
          </figure>
          <figure className="my-6 max-w-sm">
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark).png" alt="Automatically generated stripboard layout of the guitar-pedal benchmark circuit from arXiv 2512.04910: a compact stripboard with drilled strip cuts and only vertical link wires" width={846} height={777} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)-dark.png" alt="Automatically generated stripboard layout of the guitar-pedal benchmark circuit from arXiv 2512.04910, dark mode" width={846} height={777} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
              The guitar pedal benchmark circuit from Li&apos;s paper, laid out by this site&apos;s layouter.
            </figcaption>
          </figure>
          <P>
            The same idea, constraints handed to a general solver, appears much earlier in a 2012 blog post by Pepijn de
            Vos, <a href="https://pepijndevos.nl/2012/03/13/thoughts-about-generating-stripboard-layouts.html" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Thoughts about
            generating stripboard layouts</a>. It sketches the components as lists of pins, each pin&apos;s strip as an unknown, and the
            netlist as the rule that pins of one net share a strip, to be solved with a logic programming library. It is a
            sketch rather than a program, and its author lists the same open ends: cuts under components, and wires between strips.
          </P>
          <P>
            Two other projects automate the other half of the job and leave placement to the person. 
            Roger Dahl&apos;s <a href="https://github.com/rogerdahl/striprouter-cpp" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Stripboard Autorouter</a> takes the components as placed and
            searches for the cuts and wires that connect them. Its wires are bare, so every finished route blocks the space it
            crosses and the order in which connections are routed decides whether the last ones still fit; it searches over
            that order with a genetic 
            algorithm. <a href="https://sourceforge.net/projects/veroroute/" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">VeroRoute</a> by Alex Lawrow is the most complete
            interactive stripboard editor I know of, with a router that redraws the tracks between the pins while you move
            components around; its documentation says that laying out the circuit is up to the user.
          </P>
          <P>
            Another good tool does neither half.{" "}
            <a href="https://fritzing.org" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Fritzing</a> can hold a
            piece of veroboard, but components, cuts and wires are all placed by hand. Its autorouter belongs to the printed
            circuit board view and does not apply here.
          </P>
          <P>
            So each of these covers at most one half of the job. The two solver approaches place the components but don&apos;t model cuts and
            wires; the routing tools place cuts and wires but leave the components to the person. As far as I have been able to find, 
            this project is the first to attempt the whole board.
          </P>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
