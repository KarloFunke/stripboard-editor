import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import AnnealDemo from "./figures/AnnealDemo";
import SequencePairDemo from "./figures/SequencePairDemo";
import SeqPairAnnealDemo from "./figures/SeqPairAnnealDemo";
import StepLinesDemo from "./figures/StepLinesDemo";
import DecodeSteps from "./figures/DecodeSteps";
import EnergyTrace from "./figures/EnergyTrace";
import { AcceptanceChart, LandscapeSketch } from "./figures/StaticFigures";

export const metadata: Metadata = {
  title: "How Auto-layout Works",
  description:
    "How the Stripboard Editor's automatic layouter works, explained for the technically curious: what simulated annealing is, what a problem needs so it can be annealed, and how a stripboard is described, scored, searched and finished.",
  alternates: { canonical: "https://stripboard-editor.com/guide/auto-layout" },
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
  ["decoding", "5. From description to board"],
  ["score", "6. The score"],
  ["search", "7. The search"],
  ["finish", "8. Finishing the board"],
  ["portfolio", "9. Many runs, and big circuits"],
  ["limits", "10. What it cannot do"],
  ["results", "11. How well it works"],
  ["related", "12. Related work"],
  ["notes", "Notes and references"],
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
            Even a modest circuit has an enormous number of valid stripboard arrangements. Ten parts alone can be ordered and rotated
            in several million million ways. Trying them one by one is out of the question, and there is no formula
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
            First what annealing is, by demonstrating it on a simplified version of the probelm. Then
            what a problem needs so that annealing works on it. Then what a good board is, and how a stripboard layout is described, scored, searched and
            finished. It assumes an interest in how things work and nothing else.
          </P>
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
            rejected. It is kept with a probability that depends on two numbers: how much worse it makes things, and a control
            value called the temperature. Small setbacks are kept often, large ones rarely, and the temperature scales what counts
            as small. At a high temperature almost anything is kept and the search wanders freely. At a low temperature only tiny
            setbacks pass and the search behaves like the improvements-only rule. The run starts hot and cools slowly.
          </P>
          <AcceptanceChart />
          <P>
            Here is the same problem, from the same starting placement, with that one change. Watch the orange moves: early in
            the run the search happily makes the board worse, and the score chart is a jagged mess. As the temperature falls the
            orange moves thin out, the chart calms down, and the search settles into a valley. The green line is the best
            placement seen so far, which is what a run returns at the end.
          </P>
          <AnnealDemo mode="anneal" seed={8} steps={3000} caption="Annealing from the same start. Orange: worse, kept anyway. The dashed orange line is the temperature falling from 6 to 0.5 over the run. Try the shortest run: cooled four times faster it usually ends a little worse, and the longest run a little better. Switch the mode to compare with improvements only from the same start." />
          <P>
            Why does this work? While the temperature is high the search can cross the ridges between valleys, so it samples the
            whole landscape and tends to spend its time in the broad, deep regions. As it cools, it can no longer leave the region
            it is in and starts descending within it. If the cooling is slow enough, the region it is committed to when it freezes
            is very likely one of the good ones. Cool too fast and it commits early, in whatever region it happened to be. Cool
            forever and it finds the best placement there is, which is a theorem and also useless, because forever is a long time.
            Real runs choose a length and accept that they end in a good valley rather than the best one.
          </P>
          <P>
            The name comes from metallurgy. Metal that is cooled quickly ends up with its atoms frozen in a disordered jumble, full
            of internal stress. Metal that is heated and then cooled slowly gives the atoms time to find their way into an orderly
            crystal, the arrangement of lowest energy. Annealing is the slow cooling, and the search borrows the word, the
            temperature and even the formula for how often a move uphill is accepted.
          </P>
          <P>
            The method has nothing to do with circuit boards in particular, and can be used to tackle 
            a whole lot of different problems. My own first contact with it was a fantastic video by AlphaPhoenix I saw a few years ago,{" "}
            <a href="https://www.youtube.com/watch?v=Lq-Y7crQo44" target="_blank" rel="noopener noreferrer" className="text-[var(--copper)] hover:underline">
              drawing congressional district maps of North Carolina
            </a>
            , gerrymandered or fair as you please. Same Concept. If you want to see another 
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
            A run makes hundreds of thousands of proposals and every one has to be scored. In the toy above a score is a few simple
            additions, increadibly fast on a modern prozessor. For a stripboard, the scoring is much more complicated and it will include
            more then calculating the area of the board.
            The layouter needs a way to score a board in a fraction of a millisecond. Section 5 is about exactly that.
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
            Which landscape a problem presents depends less on the problem than on how its states are written down and which
            changes count as a step. The obvious way to write down a stripboard is a list of coordinates: this part at row 4,
            column 7, that one at row 9, column 2. A step then moves one part by a hole or two. That sounds gentle but it is not,
            because on a stripboard a part is defined by which strips its pins touch. Move it by one row and every one of its pins
            lands on a different strip: nets that shared a strip are torn apart, other nets are suddenly shorted together, the
            cuts move, the link wires have to be planned afresh. The score jumps by a large and essentially unpredictable amount,
            which is the saw blade on the right. A step should instead nudge the arrangement while keeping most of the strips
            and wires as they were, so that a good direction stays recognisable. Finding a way of writing down a board where
            that is true, where the neighbours of a good board are mostly good boards, was the key design decision. Section 4
            shows what it looks like.
          </P>
          <H3>The description must rule out nonsense, or price it</H3>
          <P>
            The toy rejects overlapping placements outright, which is fine for six blocks where most moves are valid. For a real
            board that would waste most of the run on rejected proposals. Better is a description in which every possible value is
            a real, overlap-free board, so no proposal is ever wasted. Whatever cannot be built into the description is then priced
            instead of forbidden: a pin that no wire can reach costs a lot, a slanted wire costs a lot, and the search learns to
            avoid them the same way it learns to avoid large boards.
          </P>
          <H3>The description must be able to express the good boards</H3>
          <P>
            The search can only ever find boards that its description can write down. That sounds obvious, but the previous two
            points push towards leaving things out: a description gets smaller and safer when it simply cannot say certain
            things. Every board it cannot say is a board the search will never see, however long it runs. If the best board needs a
            resistor placed horizontally and the description only knows vertical resistors, the run can never find it.
            So the description has to be able to express every arrangement worth finding while still
            ruling out nonsense.
          </P>
          <P>
            One more thing follows from all this: two runs from different random starts end in different valleys. It is cheap and
            effective to run several in parallel and keep the best, and the layouter does that.
          </P>

          {/* 3 */}
          <H2 id="goal">3. What a good board looks like</H2>
          <P>
            Before the search itself, it is worth being explicit about what it searches for. A stripboard layout is good when a
            person is happy to build it and can still read it afterwards. A benchmark of boards that people laid out by hand
            showed what that comes down to:
          </P>
          <UL>
            <li><strong>Complete.</strong> Every connection of the schematic is made and nothing else is connected. No two parts collide or sit closer than the clearance you asked for. Without this nothing else counts.</li>
            <li><strong>Small.</strong> Few rows and columns, and rather wide than tall, which people find easier to read.</li>
            <li><strong>Few link wires, and short ones.</strong> Every wire is a piece to cut, strip, bend and solder, and a chance to make a mistake.</li>
            <li><strong>Few cuts</strong>, preferably on a hole where a drill does the job, and lined up so that they are easy to find.</li>
            <li><strong>Connectors on an edge</strong>, so that a plug or a cable can reach them.</li>
            <li><strong>Clean wires.</strong> Every link wire runs straight along one column between two free holes, or along a spare strip, and crosses no part and no other wire.</li>
          </UL>
          <H3>Wire mess</H3>
          <P>
            The last point gets a name of its own, a huge portion of the effort has been put into figthing this. 
            Wires that are off axis (also refered to as slanted in this text) or cross a component create visual mess and makes it much harder to solder up a result.
            The pictures demonstrate it. Both are the same circuit, laid out automatically:
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
              Left, an early version of the layouter: slanted wires, wires crossing each other and running over parts. Right,
              the current one on the same circuit: every link wire runs straight along a column and crosses nothing. Both
              boards work. Only one of them is a board you would want to build (unless your a maniac).
            </figcaption>
          </figure>

          {/* 4 */}
          <H2 id="description">4. Describing a board without coordinates</H2>
          <P>
            The layouter never records where a part is. It records how the parts relate to each other, and lets the positions
            follow from that. The core of the description is a pair of orderings.
          </P>
          <H3>Reading a packing into two orders</H3>
          <P>
            Start from a finished packing of rectangles and read it in a peculiar way. For each part, draw a line: from its
            lower-left corner walk down to the bottom of the board, and whenever another part is in the way, slide left along that
            part&apos;s top edge until you can go down again; from its upper-right corner walk up to the top the same way, sliding
            right along the bottom edge of anything in the way. Join the two halves through the part. Because these lines all
            climb from lower-left to upper-right and slide around obstacles in the same direction, no two of them ever cross, and
            that means they can be read from left to right. Their left-to-right order is the first order of the parts. Now draw
            the mirror image, lines that climb from lower-right to upper-left, and read those from left to right too: that is the
            second order. Press play to watch the lines being drawn one by one.
          </P>
          <StepLinesDemo />
          <P>
            The two orders are the whole description of the packing. Take any two parts, A and B. If A comes before B in both
            orders, A is left of B. If A comes before B in the first order but after B in the second, A is above B. Hover a part
            in the figure and check it against the drawing. Every pair of parts gets exactly one of the four relations left,
            right, above, below, and because they were read off a real packing they are consistent with each other.
          </P>
          <H3>And back: from two orders to a packing</H3>
          <P>
            The trick is that this also works the other way round, from any two orders at all. Write the parts down in some
            order, then again in another order, apply the rule above to every pair, and push each part as far up and as far left
            as its relations allow. The result is a packing with no overlaps, whatever the two orders were. Try it: swap entries
            and watch the packing follow.
          </P>
          <SequencePairDemo />
          <P>
            This pair of orders is a classic trick from chip floorplanning, where it was introduced by Murata and colleagues in
            1995 under the name sequence pair. Its virtues are exactly the four requirements from section 2. Turning two orders
            into positions is a short computation, so scoring stays fast. Swapping two entries is a small change that usually
            produces a small change in the packing, and parts that keep their relations keep their strips. Every pair of orders
            is a valid packing, so no move is wasted on nonsense. And every compact packing can be written as a pair of orders,
            so nothing good is out of reach.
          </P>
          <H3>Full circle: the eight blocks as a sequence pair</H3>
          <P>
            Section 1 annealed eight blocks by nudging coordinates on a grid. Here is the same problem with the same score and
            the same cooling, but the state is now a pair of orders, and every step is: change the orders, pack, score. The
            moves are no longer to move a block on the grid but rather to change the first and or second order:
          </P>
          <ol className="list-decimal pl-5 space-y-1 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed mb-3">
            <li>Swap two parts in the first order only, which turns a left-of relation into an above relation or back.</li>
            <li>Swap two parts in both orders, which exchanges their places in the packing.</li>
          </ol>
          <SeqPairAnnealDemo seed={7} steps={3000} caption="The eight blocks of section 1, annealed as a sequence pair with the same score and the same cooling. The two rows under the board are the whole state; the outlined parts are the ones the last move touched. No move is ever rejected as not a board. Compare the chart with the annealing run in section 1." />
          <P>
            Two things have changed. There is no grey any more: every move is a board, thus no time is wasted on illegal moves.
            And the moves are bigger and better behaved at the same time. Swapping two entries
            drags the parts around them along, a whole row shifts to close a gap, yet the packing keeps most of its shape, which
            is the smooth landscape of section 2. Over forty random starts the coordinate version reaches a score of about 98
            after 750 steps and 87 after 3,000; the sequence pair version reaches 88 and 85. The same holds with 50 or 100
            blocks: the sequence pair converges faster, but given enough steps both end up about equal. On this toy the
            description buys time, not a better result.
          </P>
          <H3>The rest of the description</H3>
          <P>
            A stripboard needs more than a packing of rectangles. Stripboard has a useful property: once the parts are placed,
            almost everything else is forced. Which strips carry which nets, where the cuts have to go and which segments need a
            link wire all follow from the pin positions, and there is little to gain from clever routing. But that also means the
            packing alone decides the electrical quality of the board, and a packing of bare rectangles knows nothing about it.
            Two pins of one net land on the same strip or on different strips by accident, and a small change to the packing can
            turn one into the other and one link wire into three. That is the jagged landscape of section 2 again, and the two
            orders alone do not fix it. Their real strength is that they can be combined with further entries, and it is that
            combination which smooths the landscape: the electrical choices stop being accidents of the packing and become
            explicit parts of the description, so a move changes one choice at a time. A list of coordinates offered no place
            to put them. The toy above gained only time from the sequence pair; the stripboard gains a landscape the search can
            walk at all. So the description carries a few more entries besides the two orders, each of them a small discrete
            choice that a move can flip:
          </P>
          <UL>
            <li><strong>Rotation</strong> of every rigid part, in four steps.</li>
            <li><strong>Flat or upright</strong> for every two-legged part with flexible leads, such as a resistor or a diode, and <strong>how far its leads span</strong>, within the range you allow in the settings.</li>
            <li><strong>Which end goes where</strong> for those parts, since a resistor can be turned around.</li>
            <li><strong>Strip groups.</strong> For every net, which of its pins are asked to share one copper strip. Pins in the same group are forced onto the same row during the coonstruction of the board from this decription; pins in different groups get their own rows and are joined by a link wire later. A net with pins on three parts might work best with all three on one strip, or with one of them on a strip of its own.</li>
            <li><strong>Reserved blank lines.</strong> A part can ask for a blank row below it or a blank column beside it. Those are the rows and columns the wiring will use, and reserving them in the description lets the annealer trade area against wiring room.</li>
          </UL>
          <P>
            Together this is a list of a few hundred small integers for a typical circuit, and any list of values in range is a
            board. That is the state the annealer walks through.
          </P>

          {/* 5 */}
          <H2 id="decoding">5. From description to board</H2>
          <P>
            Scoring a description means building the board it describes and measuring it. The layouter calls this decoding. It
            has to come close to the finished board: a score based on a rough guess of where wires would go leads the search to
            boards that then cannot be wired. It is also by far the most time-critical piece of the layouter, because it runs once
            per step, so wherever a small simplification buys a large speedup that trade is made on purpose, and the last word on
            cuts and wires is left to the finishing pass of section 8. Step through a small example:
          </P>
          <DecodeSteps />
          <H3>Positions</H3>
          <P>
            The relations from the two orders, the spans of the flexible parts, the strip groups and the clearances between
            neighbouring bodies are all constraints of the form "this must be at least so many rows below that" or "these two must
            be on the same row". Finding the tightest positions that satisfy all of them is a well-known computation, the longest
            path through a graph of constraints. Rows are solved first, then columns given the rows. If the constraints contradict
            each other, which can happen when a strip group asks two pins of one part to share a row it cannot share, the decoder
            splits that group and tries again, so the description repairs itself instead of producing nonsense.
          </P>
          <H3>Strips, cuts and wires</H3>
          <P>
            With positions known, the board is drawn onto a grid: which hole holds a pin of which net, which holes are covered by a
            body. Then every row is read from left to right. Where pins of two different nets sit on one row, a cut goes between
            them, drilled through a hole if there is a spare one and knife-cut between two holes if there is not. What remains are
            strip segments, each carrying one net. Rows with no pins at all are noted separately: they are bus rows, spare copper
            any net may borrow to travel sideways.
          </P>
          <P>
            Finally each net whose pins ended up on several segments is joined up. The decoder looks for a column with a free hole
            on both segments, which gives a straight vertical wire, and where none exists it looks for a detour over a bus row: a
            hop down to the spare row, a stretch of borrowed copper, a hop back up. Each choice is priced by length and by how
            many parts it would cross, and a small spanning tree over the segments picks the cheapest set. Where no clean
            connection exists at all, the decoder does not give up; it records a slanted wire and charges for it, so the annealer
            knows this description is nearly right and not hopeless.
          </P>
          <P>
            All of that, for a board of forty parts, takes about a tenth of a millisecond. Its speed is what makes hundreds of thousands of steps
            affordable.
          </P>

          {/* 6 */}
          <H2 id="score">6. The score</H2>
          <P>
            The score of a decoded board is a weighted sum. The weights were tuned against a benchmark of hand-built boards, and
            the exact numbers matter less than the order of magnitude between the terms.
          </P>
          <UL>
            <li><strong>Area</strong> of the board, about a third of a point per cell.</li>
            <li><strong>Shape.</strong> Rows beyond the width are charged extra, because people tend to build wide boards and read them better; a ribbon more than twice as wide as tall is charged too.</li>
            <li><strong>Link wires</strong>, a few points each plus a little per unit of length. Cuts are almost free; a knife cut between two holes costs more than a drilled one, and much more when you have asked for drilled cuts only.</li>
            <li><strong>Connectors</strong> that are not on a board edge, so that plugs end up where a external wire can reach them.</li>
            <li><strong>Wire mess</strong> as defined in section 3, priced mildly at the start of the run and prohibitively at the end. Early on, the layouter is allowed a messy skeleton so the coarse arrangement can form; later the price rises until no such wire survives.</li>
            <li><strong>Unreachable pins</strong>, parts that would overlap, and clearance violations, all at a price no saving in area can pay for. These are the terms that make invalid boards lose without having to forbid them.</li>
          </UL>
          <P>
            Two consequences of this scoring are visible in every result. Because area is charged everywhere, the annealer
            packs. Because the wiring terms come from real wires on a real grid rather than from estimates, it packs in a way
            that can be wired, leaving a blank column exactly where a channel is needed and nowhere else.
          </P>

          {/* 7 */}
          <H2 id="search">7. The search</H2>
          <H3>The moves</H3>
          <P>Each step proposes one of these changes to the description, chosen at random with fixed odds:</P>
          <UL>
            <li>Swap two nearby entries in the first order, in the second, or in both.</li>
            <li>Pull a part next to another part of the same net, in both orders at once.</li>
            <li>Throw a connector to the far end of both orders, so it can reach the opposite board edge.</li>
            <li>Rotate a rigid part, flip a flexible part between flat and upright, or turn it around.</li>
            <li>Merge two strip groups of a net, or split a pin off into a group of its own.</li>
            <li>Open or close a reserved blank row or column beside a part.</li>
          </UL>
          <H3>The schedule</H3>
          <P>
            The temperature falls geometrically from 150 to 0.15 over the run, and the price of a slanted or crossing wire rises
            geometrically from 25 to 400 over the same run. Here is what a real run looks like:
          </P>
          <EnergyTrace />
          <P>
            The shape of this curve says something about the landscape. At full price, a finished board is surrounded by
            cliffs: almost any single move creates a slanted wire, an unreachable pin or a clearance violation and costs several
            hundred points, while about a third of the moves change nothing at all. Below a temperature of about ten the search is
            therefore no longer thermal in any meaningful sense. It slides along plateaus of equal score until, once in a while, a
            neutral move happens to open the way for an improving one. That is what the second half of the run is doing, and on
            large boards it is where a good part of the final quality comes from.
          </P>

          {/* 8 */}
          <H2 id="finish">8. Finishing the board</H2>
          <P>
            The annealer returns a description. Its decoded board is already complete in principle, but the decoder is a fast
            approximation of the editor&apos;s final router, so the best few descriptions of a run are handed to that router for the
            final say. It places the cuts and link wires for good.
          </P>
          <P>
            Then come the guarantees. Wherever a wire would still have to slant or run over a part, this finish inserts a blank row
            or column at the best place it can find and routes again, as many times as it takes until every wire is straight and
            crosses nothing. If you have asked for no stacked wires, a wire lying on top of another counts as an offence too. Blank
            lines the router did not use are harvested back out. Cuts are turned into drilled holes wherever a spare hole exists,
            and lined up in one collumn wherever possibe, which makes it easier to drill them.
          </P>
          <P>
            Under a locked row or column count the board cannot grow, so this stage does what it can within the limit. 
            Locked parts are treated the same way: nothing may shift, so the guarantees become best effort.
          </P>

          {/* 9 */}
          <H2 id="portfolio">9. Many runs, and big circuits</H2>
          <P>
            Every layout to solve in the settings is one independent run from its own random start, and the runs are spread over
            the processor cores of your machine. The finished boards are compared, first on completeness, then on any wire mess
            that remains, then on a rating of area, wires and cuts, and the best is applied. Because every run uses a fixed
            random seed, the same circuit with the same settings gives the same board every time. Going from one run to two
            improves the typical result by around a tenth, from five to ten by a few percent, and beyond ten the returns keep
            shrinking.
          </P>
          <P>
            Big circuits get one more trick. From twenty parts up, each run also tries six split variants. The list of circuit components is cut into
            two halves along as few connections as possible, an old graph problem with good fast solutions. Each half is annealed on
            its own under a common width or a common height, small enough that the search is quick and thorough, and the two
            finished halves are stacked or set side by side with one seam line between them, which the finishing stage wires up.
            Three sizes and two orientations
            make the six variants, and they compete with the joint runs on equal terms. Often a joint run still wins; often enough
            a split one does, and it costs a fraction of the time since effort increases a lot the more parts there are to anneal.
          </P>

          {/* 10 */}
          <H2 id="limits">10. What it cannot do</H2>
          <UL>
            <li><strong>Locked boards and locked parts</strong> take away the room the guarantees are bought with. Expect a locked run to be somewhat larger, or to keep a few slanted wires.</li>
            <li><strong>Time.</strong> A run is a few seconds for a small circuit and up to a minute or two per layout for fifty parts and more. The search is only as good as the number of steps it gets, and that number is bounded by your patience.</li>
            <li><strong>Taste.</strong> The score encodes what a benchmark of hand-built boards showed people to care about. It does not know that you wanted the LEDs in a row.</li>
          </UL>

          {/* 11 */}
          <H2 id="results">11. How well it works</H2>
          <P>
            The layouter is measured against a corpus of 271 circuits that people laid out by hand in this editor. On every one of
            them it produces a complete board with no slanted wire and no wire crossing a part. Its boards are typically smaller
            than the hand layout of the same circuit, on the median by about a quarter, with fewer link wires, though the hand
            layouts were not all built to be tight. Runs take from a second for a handful of parts to about half a minute for
            forty parts on a current desktop processor.
          </P>
          <P>
            Refer to the <Link href="/guide" className="text-[var(--copper)] hover:underline">quick guide</Link> for the buttons
            and settings. If you build something with it, or it does something odd, the{" "}
            <Link href="/feedback" className="text-[var(--copper)] hover:underline">feedback page</Link> is the place to say so.
          </P>
          {/* 12 */}
          <H2 id="related">12. Related work</H2>
          <P>
            Surprisingly little has been published on this problem. Printed circuit board tools place parts and then draw
            tracks wherever they like on an empty copper plane, and chip floorplanning, where the sequence pair comes from,
            packs rectangles and measures wire length. A stripboard is neither: the copper is already there, in one direction
            only, and the question is where to break it. What follows is everything I have found that tackles some part of it.
          </P>
          <P>
            The only published attempt at placing parts automatically is a 2025 paper by Fang Li, 
            <a href="https://arxiv.org/abs/2512.04910" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Declarative Synthesis and Multi-Objective Optimization of Stripboard
            Circuit Layouts Using Answer Set Programming</a>. It writes the placement rules down as logical constraints, hands them
            to a general constraint solver, and asks it first for any layout that satisfies them and then for the one that keeps
            the pins of each part on nearby strips on the smallest board. It comes with five benchmark circuits, of which the
            largest two have eighteen parts. Strip cuts and link wires are
            not part of that model, which is why in its layouts every net needs a strip of its own; the paper names both as
            future work. The layouter on this site solves that same guitar pedal circuit in a few seconds. The project is public, so you can{" "}
            <a href="https://stripboard-editor.com/view/96fe339f-9d00-45e3-8417-85f876e2d610" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">open it in the viewer</a>:
          </P>
          <figure className="my-6">
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)schematic.png" alt="Schematic of the guitar pedal benchmark circuit from arXiv 2512.04910 as drawn in the Stripboard Editor" width={1992} height={1122} className="w-full h-auto rounded border border-neutral-200 dark:hidden" />
            <img src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)schematic-dark.png" alt="Schematic of the guitar pedal benchmark circuit from arXiv 2512.04910 as drawn in the Stripboard Editor, dark mode" width={1992} height={1122} className="w-full h-auto rounded border border-neutral-700 hidden dark:block" />
            <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
              The guitar pedal benchmark circuit from Li&apos;s paper, as drawn in the editor: 18 parts and 12 nets.
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
            generating stripboard layouts</a>. It sketches the parts as lists of pins, each pin&apos;s strip as an unknown, and the
            netlist as the rule that pins of one net share a strip, to be solved with a logic programming library. It is a
            sketch rather than a program, and its author lists the same open ends: cuts under parts, and wires between strips.
          </P>
          <P>
            Two other projects automate the other half of the job and leave placement to the person. 
            Roger Dahl&apos;s <a href="https://github.com/rogerdahl/striprouter-cpp" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Stripboard Autorouter</a> takes the parts as placed and
            searches for the cuts and wires that connect them. Its wires are bare, so every finished route blocks the space it
            crosses and the order in which connections are routed decides whether the last ones still fit; it searches over
            that order with a genetic 
            algorithm. <a href="https://sourceforge.net/projects/veroroute/" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">VeroRoute</a> by Alex Lawrow is the most complete
            interactive stripboard editor I know of, with a router that redraws the tracks between the pins while you move
            parts around; its documentation says plainly that laying out the circuit is up to the user.
          </P>
          <P>
            Another good tool does neither half.{" "}
            <a href="https://fritzing.org" className="text-[var(--copper)] hover:underline" target="_blank" rel="noopener noreferrer">Fritzing</a> can hold a
            piece of veroboard, but parts, cuts and wires are all placed by hand. Its autorouter belongs to the printed
            circuit board view and does not apply here.
          </P>
          <P>
            So each of these covers at most one half of the job. The two solver approaches place the parts but dont model cuts and
            wires; the routing tools place cuts and wires but leave the parts to the person. As far as I have been able to find, 
            this project is the first to attempt the whole board.
          </P>

          <H2 id="notes">Notes and references</H2>
          <P>
            This page describes a layouter that is work in progress. It is the current version, it changes as I find better
            ideas, and the numbers above are the state at the time of writing. Most of the ideas in it are not mine. Simulated
            annealing, the sequence pair, solving spacing constraints as a longest path, spanning trees for wiring and the
            partitioning of large circuits are all well-known tools from other fields. What is new here is applying them to
            stripboards: the description that has the four properties of section 2, a decoder fast enough to make it work in a
            browser, and a score that matches what people build by hand. The sources I leaned on most:
          </P>
          <P>
            Thanks you for reading this far, I hope you found it intresting!
          </P>
          <ol className="list-decimal pl-5 space-y-2 text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed mb-3">
            <li>S. Kirkpatrick, C. D. Gelatt Jr. and M. P. Vecchi, &ldquo;Optimization by simulated annealing&rdquo;, Science 220, 1983. The method of sections 1 and 7.</li>
            <li>H. Murata, K. Fujiyoshi, S. Nakatake and Y. Kajitani, &ldquo;VLSI module placement based on rectangle-packing by the sequence-pair&rdquo;, IEEE Transactions on Computer-Aided Design 15, 1996, first presented at ICCAD 1995. The two orders and the step-lines of section 4.</li>
            <li>T. H. Cormen, C. E. Leiserson, R. L. Rivest and C. Stein, Introduction to Algorithms, chapter on single-source shortest paths, section on difference constraints. Turning the relations into positions in section 5: the spacing rules are difference constraints, and the Bellman-Ford algorithm solves them as a longest path.</li>
            <li>R. C. Prim, &ldquo;Shortest connection networks and some generalizations&rdquo;, Bell System Technical Journal 36, 1957. The spanning tree that joins the segments of a net in section 5.</li>
            <li>C. M. Fiduccia and R. M. Mattheyses, &ldquo;A linear-time heuristic for improving network partitions&rdquo;, 19th Design Automation Conference, 1982. The cut that splits a big circuit into two halves in section 9.</li>
          </ol>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
