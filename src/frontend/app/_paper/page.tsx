import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import "katex/dist/katex.min.css";
import { Section, Sub, P, Eq, M, Figure, Table, Th, Td, Note, Code } from "./Prose";
import { FigPipeline, FigRuntime, FigClusters } from "./figures";
import { EVALUATED, CORPUS, DEFECTIVE, FULLSET, HUMAN, FREE, J0_OUTLIER, SINGLE, PORTFOLIO, DRILLED, STACKS, LOCKED, SIZE_BANDS, JOIN_BANDS, PORTFOLIO_AB, VS_HUMAN, PHYSICS, RELAXED, BEAM, RUNTIME, PEDAL, CONSTANTS } from "./data";

export const metadata: Metadata = {
  title: "Automatic Stripboard Layout: A Staged Constructive Solver",
  description:
    "Technical description of the Stripboard Editor's layout solver: problem formulation, the staged pipeline, the objective function, a portfolio search over input orderings, and an evaluation against 210 hand-built boards and the 2025 ASP formulation.",
  alternates: { canonical: "https://stripboard-editor.com/paper" },
};

const TOC = [
  ["1", "Introduction"],
  ["2", "Problem formulation"],
  ["3", "Related work"],
  ["4", "The solver"],
  ["5", "The objective"],
  ["6", "Determinism and portfolio search"],
  ["7", "Evaluation"],
  ["8", "Comparison with the ASP formulation"],
  ["9", "Limitations and future work"],
  ["A", "Notation"],
  ["B", "Reproducibility"],
  ["C", "Beam search over constructions"],
];

export default function PaperPage() {
  const pedalAreas = PEDAL.orderings.map((o) => o.area);
  const pedalMin = Math.min(...pedalAreas);
  const pedalMax = Math.max(...pedalAreas);
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="paper" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1 relative">
        {/* Sticky contents rail, wide screens only */}
        <nav className="hidden xl:block absolute -left-56 top-12 w-48">
          <div className="sticky top-8">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--copper)] mb-2">Contents</p>
            <ul className="space-y-1.5">
              {TOC.map(([n, t]) => (
                <li key={n}>
                  <a href={`#s${n}`} className="font-serif text-[13px] leading-snug text-neutral-500 dark:text-neutral-400 hover:text-[var(--copper)] transition-colors">
                    {n}. {t}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <article className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
          <header className="mb-9">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Technical report</p>
            <h1 className="font-serif text-2xl sm:text-3xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-3 leading-tight tracking-tight">
              Automatic Stripboard Layout: A Staged Constructive Solver
            </h1>
            <p className="font-serif text-[15px] text-neutral-800 dark:text-neutral-200 mb-1">Karl Funke</p>
            <p className="font-serif text-[14px] text-neutral-600 dark:text-neutral-400 leading-relaxed">
              The layout solver behind{" "}
              <Link href="/" className="text-[var(--copper)] hover:underline">
                Stripboard Editor
              </Link>
              . Evaluated {EVALUATED.date} over {CORPUS.projects} human-built boards.
            </p>
          </header>

          {/* Abstract */}
          <section className="mb-11">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Abstract</h2>
            <p className="font-serif text-[15px] leading-[1.75] text-neutral-700 dark:text-neutral-300">
              Stripboard is a prototyping board on which every hole in a row already shares copper. Designing a circuit
              means deciding where parts sit, where the copper must be severed, and which connections need a link wire,
              under the physical constraints a real builder faces. This report describes a staged
              constructive solver that treats the assignment of nets to copper strips as the primary decision, derives
              cuts and wires from the resulting geometry, and improves the board by local search under a
              price list calibrated against hand-built work. Over a corpus of {CORPUS.projects} circuits
              hand-built by real users, it lays out every one completely and without conflicts, at a median{" "}
              {PORTFOLIO.areaRatio}&times; the human board area, leaving {PORTFOLIO.offAxis} off-axis wires (wires
              that leave the vertical) and {PORTFOLIO.crossings} wire-over-part crossings where the humans left{" "}
              {HUMAN.offAxis} and{" "}
              {HUMAN.crossings}. On the guitar-pedal benchmark published with a 2025 Answer Set Programming formulation of the same
              problem, it reaches {PEDAL.runs[1].rows}&times;{PEDAL.runs[1].cols} = {PEDAL.runs[1].area} holes against
              that work&apos;s {PEDAL.asp.rows}&times;{PEDAL.asp.cols} = {PEDAL.asp.area}, while additionally modelling
              strip cuts and body clearance.
            </p>
          </section>

          <Section n="1" title="Introduction">
            <P>
              Stripboard, sometimes called Veroboard, is a perforated board whose holes are joined into parallel copper
              strips. The copper that makes it convenient is also what makes laying out a
              circuit on it difficult. On a bare printed circuit board, two pins are unconnected until you route a track
              between them. On stripboard, two pins on the same strip are connected whether you wanted that or not.
            </P>
            <P>
              A layout is therefore built from three kinds of decision. Pins on the same net should sit on the same strip
              so the existing copper does the work. Pins of different nets sharing a strip must be separated by cutting
              the copper between them. Connections that geometry could not put on shared copper are bridged by link wires.
              Cuts and wires are consequences of placement: fix where the parts sit and the rest is forced, up to the
              router&apos;s choice of cut position and hole pair.
            </P>
            <P>
              This report describes the solver used by the Stripboard Editor, a browser-based schematic and stripboard
              tool I built. The design goal was never optimality in a formal sense, but a board an experienced builder
              would accept, produced in the seconds a user is willing to wait inside a web page. It contributes a staged
              constructive pipeline in which strip assignment rather than free 2D placement is the primary decision; a price list
              over area, wire length, off-axis wires, part crossings and board shape, calibrated
              against hand-built boards rather than chosen a priori; a deterministic portfolio search over input
              orderings; and an
              evaluation against {CORPUS.projects} boards
              laid out by hand by the tool&apos;s own users, alongside the benchmark published with a recent declarative
              formulation of the same problem.
            </P>
          </Section>

          <Section n="2" title="Problem formulation">
            <Sub n="2.1" title="Board, copper and cuts">
              <P>
                A board is a grid of <M tex="R" /> rows and <M tex="C" /> columns of holes,{" "}
                <M tex="H = \{(r,c) : 1 \le r \le R,\; 1 \le c \le C\}" />. Row <M tex="r" /> is one copper strip. Two
                kinds of cut sever it: a <em>between-cut</em> removes the copper between two neighbouring holes, and a{" "}
                <em>drilled cut</em> destroys a hole itself; most builders prefer it because a drill bit
                is easier to aim than a knife.
              </P>
              <P>
                A cut set <M tex="K" /> partitions each row into maximal runs of holes with no cut between them. I call
                these runs <em>segments</em> and write <M tex="\sigma(h)" /> for the segment containing hole{" "}
                <M tex="h" />. Two holes share copper exactly when they lie in the same segment. This is the only
                conduction the board itself provides; every further connection is made with wires.
              </P>
            </Sub>

            <Sub n="2.2" title="Parts, pins and physical feasibility">
              <P>
                A part <M tex="i" /> has a definition giving its pin pattern and its body outline. Rigid parts, such as
                DIP packages and connectors, are placed as a position plus one of four rotations. Flexible parts, such
                as axial resistors and diodes, are placed as two hole positions, one per lead, subject to a span range{" "}
                <M tex="[\underline{s}_i, \overline{s}_i]" /> that reflects how far the part&apos;s leads can be bent
                apart. A placement <M tex="\pi" /> induces a pin map <M tex="\varphi : V \to H" /> from pins to holes.
              </P>
              <P>
                Physical feasibility is not a formality here: the parts stand on the same surface they connect
                through. Bodies may not overlap, and each flexible part type carries a{" "}
                <em>clearance</em>: a whole number of free board lines, by default {CONSTANTS.defaultClearance}, that
                its body keeps to any neighbour. The default is what a standard half-watt through-hole resistor
                needs: its body is wider than the single line of holes it sits on, so two such bodies in directly
                adjacent lines would collide. A pair shares the moat; the
                requirement between two parts is the larger of their two clearances, not the sum. Rigid parts
                demand none of their own: their footprint is taken as their true body, so two footprints may abut, and
                a body that outgrows its footprint is the parts definition&apos;s problem, not the solver&apos;s. Users may change a type&apos;s clearance to fit their needs. Every
                candidate the solver considers satisfies these constraints; they are never traded against quality.
              </P>
            </Sub>

            <Sub n="2.3" title="Electrical feasibility">
              <P>
                Let <M tex="N" /> be the set of nets, each a set of pins. For net <M tex="n" />, its{" "}
                <em>copper groups</em> are the distinct segments its pins land in,
              </P>
              <Eq tex="\Gamma_n \;=\; \bigl\{\, \sigma(\varphi(v)) \;:\; v \in n \,\bigr\}." n={1} />
              <P>
                A layout <M tex="L = (\pi, K, W)" />, with <M tex="W" /> a set of link wires between holes, is feasible
                when three conditions hold:
              </P>
              <Eq tex="\text{(F1)}\quad \bigl|\{\, \nu(v) : \varphi(v) \in s \,\}\bigr| \le 1 \qquad \text{for every segment } s," n={2} />
              <Eq tex="\text{(F2)}\quad \bigl(\Gamma_n,\; W_n\bigr) \text{ is connected} \qquad \text{for every net } n," n={3} />
              <Eq tex="\text{(F3)}\quad \pi \text{ satisfies the geometric constraints of Section 2.2,}" n={4} />
              <P>
                where <M tex="\nu(v)" /> is the net of pin <M tex="v" /> and <M tex="W_n" /> are the wires joining two
                groups of <M tex="n" />. (F1) is the no-short condition and is what forces cuts; (F2) is the
                completeness condition and is what forces wires.
              </P>
              <P>
                One modelling restriction runs through everything that follows: a link wire is a straight segment
                between its two end holes. Real builders routinely bend a wire around an obstacle mid-run; the
                editor does not model bent wires yet, so neither does this solver. This is a known limitation
                (Section 9) and a good point of future work.
              </P>
              <P>
                (F2) has an immediate consequence that shaped the whole design. Since wires are only useful when they
                join two groups of the same net, connecting a net needs a spanning tree over its groups, so
              </P>
              <Eq tex="|W| \;\ge\; \sum_{n \in N} \bigl(|\Gamma_n| - 1\bigr)," n={5} />
              <P>
                with equality for a router that joins each net by a spanning tree. The wire count of a board is
                therefore almost entirely a property of the placement rather than of the router: it is fixed the moment
                the parts are placed, and the only way to need fewer wires is to put more of each net onto shared
                copper. This is why the solver spends its effort on strip assignment rather than on clever routing. The
                one thing the router may do is spend above the bound deliberately, replacing one awkward wire by two
                tidy ones through an intermediate strip (Section 4.4). All of this assumes insulated wires, which may
                share the space above the board and never block one another; where wires are bare, routes compete for
                that space, and reaching the bound stops being a matter of choosing endpoints (Section 3).
              </P>
            </Sub>

            <Sub n="2.4" title="What counts as a good layout">
              <P>
                Feasibility is binary and comes first. I summarise it as a defect count,
              </P>
              <Eq tex="q(L) \;=\; 100\,\lvert\text{shorts}\rvert \;+\; \lvert\text{incomplete nets}\rvert \;+\; 2\,\lvert\text{unplaced parts}\rvert," n={6} />
              <P>
                so that <M tex="q(L) = 0" /> means a board that can be built and will work. Among feasible layouts,
                quality is a matter of taste, and the taste I target is the one visible in hand-built boards: small,
                squarish, few and short link wires, wires that run vertically across the strips, and wires that do not
                pass over component bodies. A wire with any horizontal travel is <em>off-axis</em>; off-axis wires and
                wires crossing a component body are what the rest of this report counts as <em>wire defects</em>.
                Section 5 turns the whole list into a single number.
              </P>
              <P>
                The weight this report puts on wire defects deserves a reason, since nothing electrical is wrong with
                an off-axis wire. The reason is the builder&apos;s eye. A wire that leaves the vertical is much harder
                to follow across a crowded board, and several of them in close proximity get messy enough
                that soldering the board up without a mistake becomes a genuine challenge. A wire crossing a component
                body is the same problem in a worse form: the wire obscures the part and the part obscures where the
                wire lands. Eliminating both is much of what separates a layout that is merely correct from one a
                person will read, trust and build.
              </P>
            </Sub>
          </Section>

          <Section n="3" title="Related work">
            <P>
              Automatic layout for stripboard sits between two well-developed fields and belongs to neither. Printed
              circuit board placement and routing assumes an empty conductive plane on which tracks are created where
              wanted; the stripboard problem starts from a surface that is already fully connected in one direction and
              asks where to break it. Classical floorplanning contributes the packing machinery this solver uses in stage 2, but
              it optimises area and interconnect length and ignores the constraint that dominates here: which module
              lands on which row decides whether a connection is free or costs a wire.
            </P>
            <P>
              The closest published work is Li&apos;s Answer Set Programming formulation [1], which encodes the
              placement constraints declaratively and solves them with clingo in two phases, first feasibility and then
              optimisation of area and strip crossings. That work reports layouts for five circuits and is, as far as I
              know, the only published quantitative benchmark for the problem. It also makes two modelling choices worth
              stating plainly, because they are the reason the results in Section 8 are not directly comparable: strip
              cuts are deferred, so every net requires its own strip, and part spans are unbounded by physical geometry,
              so a resistor may stretch across ten or eleven hole pitches without a clearance model.
            </P>
            <P>
              A second line of work automates the other half of the problem. Dahl&apos;s stripboard autorouter [3]
              takes the component positions as given and searches for the wires and cuts that realise the netlist.
              A single connection is routed by uniform-cost search, alternating runs along the copper with jumper
              hops across the strips. What makes the search hard is that the jumpers are bare
              wire: a finished route permanently occupies the space it crosses, component footprints are
              closed to wires outright, and a connection routed late can fail for want of room. Route order therefore
              decides the outcome, and the algorithm is a genetic search over route orders, rating each by the
              connections it leaves unrouted. Placement
              is out of scope by design; the project&apos;s own documentation lists automatic component placement,
              and support for parts with variable lead span, as future work.
            </P>
            <P>
              VeroRoute [4], the most developed interactive stripboard editor I know of, draws the boundary in the
              same place. It takes its netlist imported from a schematic tool or painted directly
              onto component pins by the user, and its auto-router draws tracks between the pins, re-running as the
              layout is edited. Its own
              documentation states the division plainly: the program prevents short circuits and checks for
              open circuits, while it is up to the user to decide how to lay out the circuit.
            </P>
            <P>
              Prior work thus leaves placement to the person twice over. For the autorouter the reason is
              structural, and it is insulation: bare wire makes routing
              a competition for the space above the board, hard enough to absorb the whole of the effort, while
              insulated wire, which may share that space, makes routing nearly
              forced once the parts are placed (Section 2.3) and moves the difficulty into placement instead.
              Neither assumption is more correct than the other, but they decide what is left worth
              automating. This is also why Section 8 compares against Li&apos;s ASP formulation and against neither
              tool: with placement, board size and lead spans all supplied by the user, the tools solve as their
              problem what this solver takes as its input. As far as I have been able to find, automatic placement
              for stripboard has been attempted only by Li&apos;s formulation and by the solver described here.
            </P>
            <P>
              Against Li&apos;s ASP formulation my approach is the opposite in method. Rather than describing the constraints and asking a solver for a
              model, it constructs a layout in stages and repairs it, keeping a single explicit cost that decides every
              adoption. This gives up completeness and any optimality certificate. In exchange it handles the parts of
              the problem that are awkward to encode declaratively, in particular parts locked at user-chosen positions,
              user-fixed board dimensions, and a physical clearance model, and it runs inside a web worker on a laptop.
            </P>
          </Section>

          <Section n="4" title="The solver">
            <P>
              The pipeline has four constructive stages followed by refinement. Stages 0 and 1 commit to a single
              answer each; everything after them produces <em>candidates</em>. A candidate is always a complete board,
              a placement of every part with the cuts and wires of Section 4.4 re-derived for it, so alternatives are
              compared as finished boards rather than as promises. Candidates come from two kinds of source:
              construction choices with no reliable a priori winner, which the pipeline simply builds in every
              variant, and local modifications proposed against the current incumbent. Either way, every candidate
              passes through one chooser (Section 5.3), which adopts it only if it strictly improves on the incumbent,
              so no stage can make the result worse than the stage before it.
            </P>
            <Figure
              n={1}
              caption="The pipeline. Stage 0 groups the netlist by connectivity; stage 1 assigns nets to strip rows within each group; stage 2 places the resulting tiles, preferring positions where a net row of one tile meets the same net in another; stage 3 derives cuts and link wires from the geometry. Refinement and the tidy pass then propose alternatives; solid arrows carry the incumbent board, dashed ones carry candidates, and everything is judged by the one chooser."
            >
              <FigPipeline />
            </Figure>
            <P>
              The stages below are illustrated on a running example: the guitar-pedal benchmark of Section 8, an
              18-part, 12-net circuit, solved with the input ordering that produced the published board. Figure 2
              shows the circuit as drawn in the editor; the figures that follow show the state each stage hands to
              the next.
            </P>
            <Figure
              n={2}
              caption="The running example: the guitar-pedal circuit of Section 8, 18 parts and 12 nets, as drawn in the editor. The jacks and supply rails are schematic-only pins excluded from the board."
            >
              <img
                src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)-dark-schematic.png"
                alt="Schematic of the guitar-pedal benchmark circuit in the Stripboard Editor"
                width={1954}
                height={1099}
                className="w-full h-auto rounded border border-neutral-700"
              />
            </Figure>

            <Sub n="4.1" title="Stage 0: clustering the netlist">
              <P>
                Parts are grouped by connectivity before any geometry exists. The solver builds a weighted graph on parts where a
                net with <M tex="k" /> distinct member parts contributes weight <M tex="1/(k-1)" /> to each pair of its
                members:
              </P>
              <Eq tex="w_{ij} \;=\; \sum_{n \,\ni\, i,\,j} \frac{1}{k_n - 1}." n={7} />
              <P>
                This is the standard clique net model of the partitioning literature ([5], Section 2.2). The
                normalisation matters more than it looks. Power and ground nets touch nearly everything, and under
                uniform weights they fuse the whole circuit into one blob; at <M tex="1/(k-1)" /> a twenty-member supply
                net contributes about five percent of what a two-member signal net does, so supply rails neutralise
                themselves structurally without anyone having to identify them by name or colour. Names and colours are
                unreliable in user data, so this is worth having for free.
              </P>
              <P>
                Grouping is agglomerative clustering ([5], Section 6.2) in its plainest form: every part starts as
                its own cluster, and the most strongly connected pair of clusters is merged repeatedly. Connection
                strength is average linkage, the total edge weight between two clusters divided by the product of
                their sizes, so a pair of small, densely wired clusters outranks a pair of large ones that merely
                touch often. Merges that would exceed the size cap are skipped, the process stops when no
                positive-weight merge remains, and ties resolve by smallest merged size and then lowest part index,
                which keeps stage 0 deterministic. Modularity-based community
                detection was tried and abandoned: series signal chains, which is what audio circuits are, collapse into
                a single community. The size cap is small, six parts for projects up to ten parts and five above that.
                That is counter-intuitive, since small groups fragment the board, and it is the outcome of a study over
                twenty-one cap values across the full project extraction: once the refinement of Section 4.5 can fuse adjacent
                groups, many small placement problems beat few large ones, and the effect is strongest on the largest
                boards. Clustering offers the chooser nothing: one grouping feeds
                everything downstream.
              </P>
              <Figure
                n={3}
                caption="The running example as stage 0 sees it. Nodes are parts, edge thickness and darkness the pair weight of equation (7), dashed circles the five clusters agglomeration returns under the size cap. The faint web is the ground net: nine placed members put its pair weight at one eighth of a two-part signal net's, so it never pulls a cluster together on its own."
              >
                <FigClusters />
              </Figure>
            </Sub>

            <Sub n="4.2" title="Stage 1: strip assignment inside a group">
              <P>
                Each group is laid out on its own as a <em>tile</em>: a small block of rows and columns in which nets
                are assigned to strip rows. The multi-pin rigid parts of the group are placed first, by beam search over
                rotations and relative row offsets, because their pin patterns are what pin nets to rows. A rotation is
                admissible only if the assigned pins in each footprint row form at most two same-net blocks, so that one
                cut under the body separates them (a part with no admissible rotation at all stays unplaced, the
                limitation of Section 9), and only if every assigned pin can reach open board sideways: laying
                a DIP along a strip rather than across it puts half its pins on one strip, which forces a cut
                lattice that walls every pin into a one-hole segment with nowhere to attach a wire.
              </P>
              <P>
                The remaining free nets are assigned to rows by a violation-tolerant backtracking search that minimises
                tile height and then span sum. Two-pin flexible parts become vertical drops between two assigned rows,
                with the admissible row distances derived from the part&apos;s span range, including a small diagonal
                slack so that a resistor may span rows one apart if it also moves a few columns. Parts that cannot be
                satisfied fall back to a fresh row joined by one link wire, which is the same thing a human does when a
                row is full.
              </P>
              <P>
                Columns are then packed left to right around the rigids. Each hole claim carries the rank interval of
                its net&apos;s segment, so that different-net claims on a shared row keep an order that a cut can
                actually separate; without this, two parts can interleave into a pattern no cut set can untangle.
                Stage 1, too, commits to one tile per group; the alternatives the chooser will judge arise downstream,
                from how the finished tiles are placed, compacted and repaired.
              </P>
              <Figure
                n={4}
                caption="Stage 1's five tiles for the running example, each sized to its content, before any cuts or wires exist; border colors match the cluster hulls of Figure 3 and the boxes of Figure 5. Strips carrying pins of more than one net show as conflicts; deriving the cuts that separate them is stage 3's job. The two potentiometers, the transistor and the two effect chips anchor their tiles as the rigid parts whose pin patterns pin nets to rows."
              >
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <img src="/stage1-t1-dark.png" alt="Stage 1 tile with Tone1, Volume1, C5, D1, D2" width={1000} height={325} className="h-auto rounded border-2" style={{ width: "52%", borderColor: "#f59e0b" }} />
                    <img src="/stage1-t2-dark.png" alt="Stage 1 tile with Q1, Gain1, R3, C4" width={903} height={465} className="h-auto rounded border-2" style={{ width: "46%", borderColor: "#22d3ee" }} />
                  </div>
                  <div className="flex items-start gap-2">
                    <img src="/stage1-t4-dark.png" alt="Stage 1 tile with Boost1, R1, C3" width={750} height={396} className="h-auto rounded border-2" style={{ width: "46%", borderColor: "#e879f9" }} />
                    <img src="/stage1-t3-dark.png" alt="Stage 1 tile with R5, R6, C2" width={477} height={537} className="h-auto rounded border-2" style={{ width: "25%", borderColor: "#a3e635" }} />
                    <img src="/stage1-t5-dark.png" alt="Stage 1 tile with C1, R2, R4" width={466} height={525} className="h-auto rounded border-2" style={{ width: "25%", borderColor: "#f43f5e" }} />
                  </div>
                </div>
              </Figure>
            </Sub>

            <Sub n="4.3" title="Stage 2: floorplanning the tiles">
              <P>
                Finished tiles are placed individually into the absolute frame, so a tile
                may nest into the unused interior of another, with candidate positions drawn from adjacency plus{" "}
                <em>row-alignment</em> spots where a tile&apos;s net row lands on the same absolute row as another
                tile&apos;s pin of the same net. That alignment is the whole point: it turns a link wire into bare
                copper. The floorplan is scored by
              </P>
              <Eq tex="F \;=\; \tilde{R}\tilde{C} \;+\; \lambda_w \hat{w} \;+\; \lambda_\ell \hat{\ell} \;+\; 200\,\mathrm{over} \;+\; A(\tilde{R}, \tilde{C})" n={8} />
              <P>
                with <M tex="\hat{w}" /> the estimated wire count from board-wide copper fragments computed by
                union-find, <M tex="\hat{\ell}" /> a minimum-spanning-tree estimate of wire length over those fragments,{" "}
                <M tex="\mathrm{over}" /> the overflow beyond any user-locked dimension, and <M tex="A" /> the aspect
                penalty of Section 5.3. The weights are <M tex="\lambda_w = " />
                {CONSTANTS.wireWeight}, <M tex="\lambda_\ell = " />
                {CONSTANTS.lenWeight} normally and {CONSTANTS.wireWeightCapped} and {CONSTANTS.lenWeightCapped} when a
                board dimension is locked, where greedy construction otherwise drifts wide and cannot recover. Effective
                dimensions <M tex="\tilde{R}, \tilde{C}" /> charge a locked dimension in full whether it is used or not,
                since the physical board does not shrink.
              </P>
              <P>
                A per-net bounding-box estimate of wire length was tried first and is useless here: it has zero gradient
                for a fragment in the interior of a net&apos;s bounding box, so refinement stalls. The spanning-tree
                estimate over copper fragments fixed that, and only with it did the wire-length weights change anything
                at all.
              </P>
              <P>
                This is the stage where candidates begin to multiply. Two placement strategies always run, this
                floorplanner and an older band-stacking composer it largely superseded but which still wins on some
                shapes, each at two tile spacings; and each result is offered to the chooser loose, fully compacted,
                and, where full compaction breaks the routing, at the tightest compaction that does not. The
                generosity is deliberate. Which combination wins depends on the circuit in ways no rule I tried could
                predict, and building all of them and letting the price list decide turned out to be both simpler and
                better than being clever.
              </P>
              <Figure
                n={5}
                caption="The adopted stage-2 construction of the running example: the five tiles of Figure 4 composed at 11×21, outlined in their cluster colors as the packer placed them, with cuts and wires already derived, since every candidate is judged as a finished board. The long vertical wires are inter-tile connections the composition could not turn into shared copper. Refinement shaves this board to the 11×19 of Figure 6, breaking the tile boundaries up in the process."
              >
                <div className="relative">
                  <img
                    src="/stage2-dark.png"
                    alt="The composed stage-2 construction of the guitar-pedal example at 11 by 21 holes"
                    width={1788}
                    height={973}
                    className="w-full h-auto rounded border border-neutral-700"
                  />
                  {/* tile footprints as placed, in the cluster colors; grid mapping
                      measured from the screenshot (origin 129,130, pitch 79) */}
                  <svg viewBox="0 0 1788 973" className="absolute inset-0 w-full h-full" aria-hidden="true">
                    {[
                      { x: 178, y: 179, w: 692, h: 218, c: "#f59e0b" },
                      { x: 178, y: 495, w: 613, h: 376, c: "#22d3ee" },
                      { x: 889, y: 495, w: 376, h: 455, c: "#a3e635" },
                      { x: 968, y: 100, w: 692, h: 297, c: "#e879f9" },
                      { x: 1363, y: 495, w: 376, h: 455, c: "#f43f5e" },
                    ].map((r, i) => (
                      <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={14} fill="none" stroke={r.c} strokeWidth={5} />
                    ))}
                  </svg>
                </div>
              </Figure>
            </Sub>

            <Sub n="4.4" title="Stage 3: completion, cuts and wires">
              <P>
                Given placed parts, completion is deterministic and is recomputed from scratch for every candidate board
                the search considers. It generates no candidates of its own; it is the measuring instrument that turns
                any placement, from whatever source, into a finished board the chooser can price. Cuts come first. Every place where two nets would share a segment gets a cut, with
                the position inside the gap chosen by need: a run of pins that still has to receive a link wire keeps a
                free hole on its side. Cuts are then upgraded to drilled holes wherever the sacrificed hole is provably
                surplus, preferring holes under a component body or under the corridor of a horizontally mounted part,
                where the hole costs nothing at all because it is unusable anyway. Routing runs on the un-upgraded
                segmentation first, so an upgrade can never change which wires are needed.
              </P>
              <P>
                Wires are then routed net by net, joining copper groups until each net is connected. For each pair of
                groups the router searches the cheapest pair of free holes under the pricing of Section 5.2. It may also
                route through a <em>relay</em>: a stretch of copper carrying no pins, or a free tail of a segment beyond
                a pin span donated by one extra cut, reached in two vertical hops rather than one diagonal one. A relay
                costs an extra wire and a small tax, and wins whenever it converts an off-axis wire into two vertical ones.
              </P>
              <P>
                Two failure modes get explicit treatment. When a group has no free hole at all, which happens on
                tight-pitch connectors and grid-array parts whose interior segments are a single hole, the router may
                use the pin&apos;s own solder joint as an endpoint at a penalty of {CONSTANTS.pinSharePenalty}, which is
                what a human does; this is enabled only for layouts with user-locked parts, where the alternative is
                failure. Otherwise a starved net is a defect and the candidate is rejected. The structural fix lives
                upstream: the packer enforces an invariant that every run of pins needing a wire keeps at least one free
                hole in its segment, which removed this failure class at the source rather than rescuing it afterwards.
              </P>
              <P>
                A final cosmetic pass slides each cut within the dead zone where it is electrically free to move,
                towards columns that other cuts already use, so that a run of cuts can be drilled along one straight
                line. Over the corpus this raises the share of cuts sharing a column from 72% to 82% and reduces the
                number of distinct cut columns by a quarter; the resulting partition of the board into segments was
                verified identical on every project, so the pass is cosmetic by construction.
              </P>
              <P>
                A project option pushes the drill preference to its limit. In <em>drilled-cuts-only</em> mode the
                router also severs donated relay tails by sacrificing a tail hole rather than knifing the copper
                beside it, and every between-cut the upgrade cannot absorb is priced like an off-axis wire (Section
                5.3), so layouts that leave room to drill win. Between-cuts that no placement can remove are exempt
                from the price; two directly adjacent pins of one footprint force a knife cut between them, and
                charging the unavoidable would only distort every comparison. Over the corpus the mode cuts
                knife cuts from {DRILLED.betweenCutsNormal} to {DRILLED.betweenCuts} at a median area of{" "}
                {DRILLED.areaRatio}&times; the human board against the normal mode&apos;s {PORTFOLIO.areaRatio}
                &times;, with wire tidiness essentially unchanged ({DRILLED.cleanBoards} boards free of wire defects
                against the normal mode&apos;s {PORTFOLIO.cleanBoards}). One design lesson is recorded here because it was measured both
                ways: upgrading cuts to drills <em>before</em> routing, so endpoints could never box a cut in, saved
                a third of a knife cut per board and paid 26 off-axis wires and 16 crossings for it; every early
                drill destroys a hole a link wire might have used. The upgrade therefore stays where it always was,
                after routing, where it can only take holes that are provably surplus.
              </P>
            </Sub>

            <Sub n="4.5" title="Refinement">
              <P>
                The constructed board is then improved by local search, which is the second source of candidates: each
                pass takes the incumbent, applies one bounded modification, and offers the result back to the chooser
                as a complete board. Compaction greedily deletes grid lines nothing depends on, with a veto that permits a removal unless it
                creates a new violation, evaluated against the layout&apos;s pre-existing violations rather than against
                perfection. Each tile is then re-optimised by an annealing placement optimiser inherited from the
                editor&apos;s earlier solver, run over that tile&apos;s members with the rest of the board frozen, after
                which a compaction pass harvests the space the annealer freed. The harvest is not optional in practice:
                without it the annealing gains stay local and the board does not shrink at all.
              </P>
              <P>
                Two further passes target wires specifically. <em>Channel insertion</em> proposes a blank column inside
                the column span of an off-axis wire, or a blank row beside a chip, either of which gives every crossing
                strip a free hole and so lets two rows connect vertically. <em>Off-axis repair</em> slides derived cuts and
                one-hole parts, which may move anywhere on their row since cuts and wires are re-derived afterwards, to
                clear an approach for a vertical wire. Both are proposals only; they cost real board area and are
                adopted only when the pricing says the area is worth it.
              </P>
              <Figure
                n={6}
                caption="The running example after refinement: compaction and the tile polish shave two columns from the construction of Figure 5, reaching the 11×19 of the published board. On this ordering the tidy pass of Section 4.6 finds the result already free of wire defects and adopts nothing, so this is the finished layout up to cut alignment."
              >
                <img
                  src="/stage-5-dark.png"
                  alt="The guitar-pedal example after refinement at 11 by 19 holes"
                  width={1651}
                  height={982}
                  className="w-full h-auto rounded border border-neutral-700"
                />
              </Figure>
            </Sub>

            <Sub n="4.6" title="The tidy pass">
              <P>
                The tidy pass generates candidates at the coarsest scale: whole re-solves of the pipeline under
                altered constraints, competing with the base result as finished boards. A finished board that still
                contains off-axis wires or crossings gets solved a second time with its own
                achieved width imposed as a lock. This sounds circular and is the single most effective quality
                mechanism in the solver. The reason is economic: under a locked dimension the effective area{" "}
                <M tex="\tilde{C} = \max(C_{\text{cap}}, C)" /> is paid in full whether used or not, so an empty column
                inside the cap is free. Channels, relay rows and loose packing that the unconstrained search rejected as
                too expensive become gratis, and the growth is channelled into rows, which are fresh strips and
                therefore useful material.
              </P>
              <P>
                Netlists dominated by integrated circuits get extra variants. Let <M tex="I_n" /> be the IC-like parts
                (at least {CONSTANTS.icMinPins} pins) on net <M tex="n" />; the <em>rigid join</em> count
              </P>
              <Eq tex="J \;=\; \sum_{n \in N} \max\bigl(0,\; |I_n| - 1\bigr)" n={9} />
              <P>
                counts connections between fixed pin patterns that no flexible part can absorb by bending. It predicts
                the residual wire mess of Section 5.2 better than any other netlist statistic I measured (Spearman 0.58
                against the wire mess of the finished board, with a sharp knee at <M tex="J = 0" />), and boards with <M tex="J > 0" /> are
                re-solved with extra headroom so that a bus row or a channel can be inserted where the plain variant had
                no room.
              </P>
              <P>
                Acceptance is guarded. A variant replaces the base result only when it is complete, within its cap and
                growth allowance, has no more part crossings, has strictly lower wire mess, and is no worse than the
                base on the overall rating of equation (16). The crossing guard is not redundant: without it the
                search happily trades long off-axis wires for wires running over component bodies, which is legal
                under the score and wrong to the eye. The rating guard earns its place the same way: the growth
                allowance is unlimited by default, and before the guard existed a variant could buy the removal of a
                single slanted wire with nineteen extra board rows; that is strictly tidier, and plainly not worth it.
                Under
                the guard the variant&apos;s extra board must pay for its mess win at the same exchange rate as every
                other decision.
              </P>
            </Sub>
          </Section>

          <Section n="5" title="The objective">
            <Sub n="5.1" title="Feasibility first">
              <P>
                Candidates are compared lexicographically on a defect term and then a cost. The defect term is
              </P>
              <Eq tex="b(L) \;=\; 100\,\lvert\text{shorts}\rvert \;+\; 40\,\mathrm{over}(L) \;+\; \lvert\text{starved nets}\rvert" n={10} />
              <P>
                where a starved net is one the router could not connect for want of a free hole, and{" "}
                <M tex="\mathrm{over}" /> is the overflow beyond user-locked dimensions. The relative weights encode a
                policy: a short is unacceptable, exceeding a board size the user physically owns is worse than leaving a
                net for them to wire by hand, and everything else is a matter of cost. This is not the same count as{" "}
                <M tex="q(L)" /> of equation (6): <M tex="q" /> describes a finished board, while <M tex="b" /> ranks
                candidates during search, where overflow and starvation are the failure modes that must be kept apart.
              </P>
            </Sub>

            <Sub n="5.2" title="Pricing a wire">
              <P>
                Wires are priced in units of holes, as an <em>extra effective length</em> added to their true length.
                For a wire <M tex="w" />, write <M tex="\Delta c" /> for its column travel and{" "}
                <M tex="\lVert w \rVert_2" /> for its length in holes; then
              </P>
              <Eq tex="x(w) \;=\; \mathbb{1}[\Delta c \neq 0]\cdot \rho \max\bigl(0,\; \lVert w \rVert_2 - \phi\bigr) \;+\; \kappa\,\bigl\lvert\mathrm{cross}(w)\bigr\rvert" n={11} />
              <P>
                with <M tex="\phi = " />
                {CONSTANTS.offAxisFree}, <M tex="\rho = " />
                {CONSTANTS.offAxisRate} and <M tex="\kappa = " />
                {CONSTANTS.crossExtra}, where <M tex="\mathrm{cross}(w)" /> are the component bodies the wire passes
                over. Read it as two statements about hand-built boards. A wire with any horizontal travel pays double
                for every hole beyond the first, so a vertical jumper, or a pair of vertical hops through a relay strip,
                wins whenever one exists, while a one-hole diagonal between adjacent strips stays nearly free because
                grid-array parts need them. And a wire passing over a component body costs eight holes, so a clean
                detour of similar length wins.
              </P>
              <P>
                Wires may also run collinearly on top of one another; this is physically fine under insulation, and a
                standard human technique for parallel runs sharing a column. A candidate additionally pays a{" "}
                <em>stacking charge</em> <M tex="\tau(w)" /> set by the deepest pile it would join at any point of its
                run: becoming the second wire in a channel costs {CONSTANTS.stackSecond}, still cheaper than a slant
                of a few holes; becoming the third costs {CONSTANTS.stackThird}, so only a real detour loses to it;
                and a fourth wire in one channel is barred outright, softening to a price of{" "}
                {CONSTANTS.stackRescue} per extra lane only when a net cannot complete any other way, so the cap can
                never starve a board that the flat rule would have finished. Under the k = 10 portfolio only{" "}
                {STACKS.atCap} of the {CORPUS.projects} boards contain a channel at the three-wire cap, and the
                rescue has fired exactly once: one nine-part board completes with a single four-wire channel that
                the flat ban would have starved.
              </P>
              <Note>
                Stacking was once banned outright, and replacing the ban by a price was the largest single quality
                improvement in the project&apos;s history: total off-axis wires over the corpus fell 55% and part
                crossings 41%, while the boards got <em>smaller</em>. The escalating schedule above came later, after
                a real build: an unbounded flat rate let three and four wires pile into one channel, which is exactly
                as unpleasant to solder as it sounds.
              </Note>
              <P>
                None of the rates in this section was calibrated the way <M tex="\lambda_A" /> of Section 5.3 was.{" "}
                <M tex="\rho" /> and <M tex="\kappa" /> are judgements about what a builder minds when reading a
                finished board, and the stacking schedule came from the build the note describes; none of them was
                swept over the corpus. They are reported as what the shipped solver uses rather than as tuned values,
                and a ladder like the one behind <M tex="\lambda_A" /> could well move them.
              </P>
              <P>
                The <em>wire mess</em> of a finished board sums the per-wire price and stacking charge together with
                a flat charge per off-axis wire,
              </P>
              <Eq tex="M(L) \;=\; \sum_{w \in W} \Bigl( \mathbb{1}[\Delta c \neq 0] + x(w) + \tau(w) \Bigr)." n={12} />
            </Sub>

            <Sub n="5.3" title="Candidate cost">
              <P>
                Among candidates with equal defect count, the chooser minimises
              </P>
              <Eq tex="\mathrm{cost}(L) \;=\; \lambda_A\,\tilde{R}\tilde{C} \;+\; \sum_{w} \bigl(x(w) + \tau(w)\bigr) \;+\; \sum_{w} \lVert w \rVert_2 \;+\; A(R,C) \;+\; \max(R,C)\cdot s(L)" n={13} />
              <P>
                where <M tex="s(L)" /> is the number of off-axis wires, <M tex="\lambda_A = " />
                {CONSTANTS.areaWeight} is the price of a board cell, and the aspect penalty is
              </P>
              <Eq tex="A(R,C) \;=\; \max\bigl(0,\; \max(R,C) - 2\min(R,C)\bigr)\cdot\min(R,C)," n={14} />
              <P>
                zero when the user has locked a dimension, since the shape is then their choice. Everything is
                measured in one currency, holes of wire, and <M tex="\lambda_A" /> is the exchange rate against board
                area. It stood at 1 for most of the project&apos;s history; a cell of board and a hole of wire
                weighing exactly the same is the claim that density must not buy ugly or long wires. It was lowered
                after building a board by hand made the direction of the remaining error obvious: on the bench, extra
                board is nearly free and every awkward wire costs real attention. The final value came from a ladder
                of corpus runs. Halving the cell price to 0.5 removed a fifth of the remaining wire defects for one
                percentage point of median area; 0.35 removed another quarter for three more points; 0.25 bought
                nothing further; the defects merely shuffled while one board grew by 372 cells, so the price stopped
                being the binding constraint there, and {CONSTANTS.areaWeight} is where the calibration settled:
                board space is cheapened exactly until cheapening it stops making boards tidier.
              </P>
              <P>
                The last term is the one that took longest to find. An off-axis wire costs a whole board line. That
                exchange rate came from an experiment on myself: I took a messy solver output and cleaned it up by hand
                until it looked right, inserting bus rows and blank columns, and ended with a board that was noticeably
                larger and plainly better. Priced back, the trade I had been making was roughly one board line per
                straightened wire. Before the term existed, channel insertion and off-axis repair were proposals that
                could essentially never pay for themselves, and the passes ran without ever firing. In drilled-cuts
                mode (Section 4.4) each avoidable between-cut joins <M tex="s(L)" /> in this term, priced like a
                slanted wire.
              </P>
            </Sub>
          </Section>

          <Section n="6" title="Determinism and portfolio search">
            <P>
              The solver contains no randomness at the top level. Given the same inputs it returns the same board, which
              users expect and which makes regression testing over the corpus meaningful, since any output difference is
              a real behavioural change.
            </P>
            <P>
              It is, however, sensitive to the <em>order</em> of its input arrays. Clustering ties, ties in the strip
              assignment beam, packing order and first-wins comparisons in the routing search all resolve by input
              order, so permuting
              the component list of an unchanged netlist lands the search in a different local optimum. The effect is
              not small. Table 1 shows ten seeded permutations of the guitar-pedal netlist, each solved through the
              complete pipeline: every result is a complete, clean board, and their areas span {pedalMin} to{" "}
              {pedalMax} holes, a {Math.round((pedalMax / pedalMin - 1) * 100)}% spread.
            </P>

            <Table n={1} caption="Ten seeded input orderings of the same netlist, each solved to completion. All ten are complete boards with no off-axis wires and no crossings.">
              <thead>
                <tr>
                  <Th>Ordering</Th>
                  <Th right>Board</Th>
                  <Th right>Holes</Th>
                  <Th right>Wires</Th>
                  <Th right>Cuts</Th>
                </tr>
              </thead>
              <tbody>
                {PEDAL.orderings.map((o) => (
                  <tr key={o.i}>
                    <Td strong={o.area === pedalMin}>{o.i === 0 ? "0 (as given)" : o.i}</Td>
                    <Td right>
                      {o.rows}&times;{o.cols}
                    </Td>
                    <Td right strong={o.area === pedalMin}>
                      {o.area}
                    </Td>
                    <Td right>{o.wires}</Td>
                    <Td right>{o.cuts}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <P>
              This is exploitable. Define a family of permutations <M tex="\sigma_0, \sigma_1, \ldots" /> of the input
              arrays, where <M tex="\sigma_0" /> is the identity and <M tex="\sigma_i" /> for <M tex="i \ge 1" /> is a
              Fisher-Yates shuffle driven by a small deterministic generator seeded by
            </P>
            <Eq tex="s_i \;=\; \texttt{0x9e3779b9} \;\oplus\; \bigl(i \cdot \texttt{0x85ebca6b} \bmod 2^{32}\bigr)." n={15} />
            <P>
              Each ordering is solved through the complete pipeline, tidy pass included, and the finished boards compete
              on the rating
            </P>
            <Eq tex="S(L) \;=\; \lambda_A\,RC \;+\; M(L) \;+\; \sum_{w} \lVert w \rVert_2 \;+\; \max(R,C)\cdot s(L)," n={16} />
            <P>
              which restates (13) on the trimmed final board, with the wire mess <M tex="M(L)" /> of (12) standing in
              for the raw per-wire prices and the aspect penalty dropped. The penalty is a steering term for
              construction, and every finished candidate has already been shaped by it during its own solve; charging
              shape again at selection time would only trade it against area a second time. The winner is the
              lexicographic minimum of <M tex="(q, c, S, i)" />, where <M tex="c" /> is the count of wire-over-part
              crossings: crossings may never trade up between finished candidates, the same guard the tidy pass
              enforces internally. This <em>guarded pick</em> was measured before it was adopted (Appendix C): on the
              plain portfolio it changes only a handful of boards, each growing to remove its crossings outright.
              Including the index makes ties resolve to the earliest ordering, and since <M tex="\sigma_0" /> is the
              caller&apos;s own ordering and wins ties, a portfolio of any size can never score worse than the single
              solve it replaces.
            </P>
            <Note>
              Rating the <em>finished</em> board matters. An earlier version picked a winner from the first-pass results
              and then ran the tidy pass on the winner&apos;s ordering only. That is cheaper by a factor of two, and it
              regressed 28 projects, one by 255 cells, because an ordering that looks best before the tidy pass need not
              be best after it. The pipeline was restructured so that every ordering runs end to end.
            </Note>
            <P>
              Orderings are independent, so the editor runs them in parallel web workers, by default on three
              quarters of the machine&apos;s cores, with workers pulling ordering indices from a shared counter. The
              portfolio size is a fixed count rather than a time budget; an earlier revision shipped a
              five-second budget, which made the result depend on the machine that computed it. The fixed count
              makes the shipped default exactly reproducible everywhere: k = {CONSTANTS.permBoards} orderings,
              reduced to{" "}
              {CONSTANTS.permBoardsMid} on projects above {CONSTANTS.permBoardsMidAbove} parts and to a single solve
              above {CONSTANTS.permBoardsSingleAbove}, where one solve alone runs tens of seconds on an average
              machine and the larger portfolio should be the user&apos;s explicit choice. The k = 10 row of Table 2
              is therefore the shipped default for the bulk of the corpus, not an idealised configuration.
            </P>

            <P>
              Input orderings are not the only place to inject variance. The ladder of Section 4.3 builds several
              complete constructions and refines exactly one, so refining all of them, beam search over constructions,
              is the obvious alternative, and the solver supports it behind an option. It does not pay off. At an equal
              number of solves it matches a portfolio of five orderings on area while roughly doubling the wire
              defects, it skews board shape towards long strips, and its cost is set by the circuit rather than by a
              budget the user chose. Appendix C reports the comparison in full. The shipped configuration searches over
              input orderings only.
            </P>
          </Section>

          <Section n="7" title="Evaluation">
            <Sub n="7.1" title="Corpus and protocol">
              <P>
                Every figure in this section rests on one set of {CORPUS.projects} circuits, and nothing below ever
                switches to a different one. The set is built as follows. Provenance comes first: of the{" "}
                {CORPUS.stored} projects stored at extraction time, only those that provably owe nothing to the solver
                are considered, namely the ones last saved before the first solver release (16 July 2026) and the ones
                created after the editor began recording solver usage (31 July 2026) that never recorded a run.
                Projects touched in the window between the two, where the solver existed but its use went unrecorded,
                are dropped outright, since a board saved there cannot be told apart from a solved one. That leaves{" "}
                {CORPUS.provable} projects whose layouts are hand-built by construction. Extracting these yields{" "}
                {CORPUS.extracted} usable layouts: those where every non-excluded part is placed, deduplicated by
                a content hash of the layout, and trimmed to their content, since users commonly oversize a board and
                use the empty border as scratch space. From these, {CORPUS.unresolvable} projects are dropped because their parts
                name component definitions that no longer exist, which makes them invisible to the solver and to the
                editor alike: unsolvable data rather than hard instances. A further {CORPUS.defective} are dropped
                because the stored human board contains a short or an unconnected net, and an unfinished board is not a
                fair thing to measure a finished one against. That leaves {CORPUS.projects} circuits, each with a
                complete hand-built layout that the solver demonstrably played no part in. Median size is{" "}
                {CORPUS.partsMedian} parts and{" "}
                {CORPUS.netsMedian} nets, with a 90th percentile of {CORPUS.partsP90} and a maximum of{" "}
                {CORPUS.partsMax} parts.
              </P>
              <P>
                For each of them the solver receives the netlist with all placements stripped, and its board is compared
                against what the human built. Decisions that need no human reference, such as the cluster-size study of
                Section 4.1 and the runtime profiling of Section 7.6, were taken over the wider extraction; those are
                tuning experiments, and none of their numbers appear here.
              </P>
              <P>
                One caveat no filtering fixes. The corpus is self-selected: it is the users of one editor, not a random
                sample of stripboard practice, and dropping the unfinished boards plausibly removes the circuits people
                found hardest.
              </P>
              <P>
                The second half of that worry is testable. The {CORPUS.defective} projects dropped for a defective human
                board have sound netlists; it is the stored layout that is unfinished, not the circuit. Solved under
                the same k = {CONSTANTS.permBoards} portfolio they all complete, leaving {DEFECTIVE.offAxis} off-axis
                wires and {DEFECTIVE.crossings} crossings over the set, with {DEFECTIVE.cleanBoards} of{" "}
                {CORPUS.defective} free of wire defects; that is a defect rate no worse than on the {CORPUS.projects}{" "}
                finished boards. No area ratio is quoted for them, since a board its author did not finish is not
                something to measure area against. This does not establish that these were the hard circuits, as a
                board saved with an open net may simply be work in progress, but it does rule out the reverse
                reading: the filter that produces the comparison subset hides no class of circuit the solver cannot
                do. Counted in, the solver lays out all {CORPUS.extracted - CORPUS.unresolvable} circuits the
                extraction could resolve. Widening once more to every extractable project regardless of provenance,
                including boards their authors never finished placing, the same configuration completes{" "}
                {FULLSET.complete} of {FULLSET.projects}; the one exception is a switch whose 3&times;3 pin grid the
                strip-assignment model cannot represent, discussed in Section 9.
              </P>
              <P>
                A second caveat concerns tuning. The solver was developed against this corpus: the price list of
                Section 5 and most heuristic choices were made while watching these numbers, so every figure in this
                section is in-sample, and there is no held-out set. Comparisons between configurations remain fair,
                since all of them run on the same data, but the absolute margins over the human reference should be
                read with that in mind. The provenance filter above already
                guarantees no reference board was made with the solver; it cannot guarantee the solver was not tuned
                toward these boards, since most of them were in the wider extraction the price list was developed
                against. A clean holdout is accumulating on its own: hand-built boards saved since usage tracking began
                are identifiable as such, and enough of them will support an out-of-sample evaluation later.
              </P>
              <P>Metrics, all measured by one harness on both sides:</P>
              <ul className="font-serif text-[15px] leading-[1.75] text-neutral-700 dark:text-neutral-300 space-y-1.5 mb-3 list-disc pl-5">
                <li>
                  <em>Complete</em>: no shorts, no unconnected nets and no unplaced parts, i.e. <M tex="q(L)=0" />. A
                  board that is not complete is not compared on anything else.
                </li>
                <li>
                  <em>Area ratio</em>: solver board area divided by the human board area, reported as a median over
                  projects.
                </li>
                <li>
                  <em>Aspect</em>: the longer board dimension divided by the shorter, reported as a median over
                  projects.
                </li>
                <li>
                  <em>Off-axis wires</em> and <em>crossings</em>: corpus totals of off-axis link wires and of
                  wire-over-part crossings.
                </li>
                <li>
                  <em>Strip-complete</em>: share of nets needing no wire at all because their pins already share copper.
                </li>
                <li>
                  <em>Clean boards</em>: projects finishing with no wire defect, i.e. no off-axis wire and no crossing
                  anywhere.
                </li>
              </ul>
            </Sub>

            <Sub n="7.2" title="Results">
              <Table n={2} caption={`Unconstrained runs over the ${CORPUS.projects} circuits: the solver chooses the board size and nothing is locked. Row 1 disables the tidy pass; row 2 solves one input ordering; rows 3 and 4 run the portfolio at fixed ordering counts. The editor's default is the k = 10 row itself for projects up to ${CONSTANTS.permBoardsMidAbove} parts; larger projects default to k = ${CONSTANTS.permBoardsMid} or a single solve so a first run stays quick. All four lay out every circuit completely, so the table shows only quality. Time is the median wall-clock per project as a user experiences it: one circuit at a time on an otherwise idle machine, with a portfolio's orderings solved simultaneously in parallel workers, the way the editor runs them. Figure 7 breaks the single-ordering time down by project size. The Human row is the same boards as their authors built them.`}>
                <thead>
                  <tr>
                    <Th>Configuration</Th>
                    <Th right>Area</Th>
                    <Th right>Aspect</Th>
                    <Th right>Wires</Th>
                    <Th right>Off-axis</Th>
                    <Th right>Cross</Th>
                    <Th right>Clean</Th>
                    <Th right>Time</Th>
                  </tr>
                </thead>
                <tbody>
                  {FREE.map((c) => (
                    <tr key={c.label}>
                      <Td strong={c === PORTFOLIO}>{c.label}</Td>
                      <Td right strong={c === PORTFOLIO}>
                        {c.areaRatio.toFixed(2)}&times;
                      </Td>
                      <Td right>{c.aspect.toFixed(2)}</Td>
                      <Td right>{c.wires}</Td>
                      <Td right>{c.offAxis}</Td>
                      <Td right>{c.crossings}</Td>
                      <Td right>{c.cleanBoards}</Td>
                      <Td right>{(c.msMedian / 1000).toFixed(1)}s</Td>
                    </tr>
                  ))}
                  <tr>
                    <Td strong>Human</Td>
                    <Td right>1.00&times;</Td>
                    <Td right>{HUMAN.aspect.toFixed(2)}</Td>
                    <Td right>{HUMAN.wires}</Td>
                    <Td right>{HUMAN.offAxis}</Td>
                    <Td right>{HUMAN.crossings}</Td>
                    <Td right>{HUMAN.cleanBoards}</Td>
                    <Td right>&ndash;</Td>
                  </tr>
                </tbody>
              </Table>

              <P>
                Every configuration in the table lays out all {CORPUS.projects} circuits completely and without
                conflicts, so the interesting differences are all in the quality columns. The k = 10 portfolio, the
                reference configuration for the rest of this section, comes out at a median {PORTFOLIO.areaRatio}&times;
                the human area, with a median aspect ratio of {PORTFOLIO.aspect} against {HUMAN.aspect} for the humans,
                so the shape distribution sits where the reference does; the long ribbons the
                early staged pipeline favoured, before the aspect penalty and the tidy pass existed, are gone.
              </P>
              <P>
                The median hides a wide spread. Per project, the portfolio is smaller than the human board
                on {VS_HUMAN.smaller} of the {CORPUS.projects} circuits, equal on {VS_HUMAN.equal} and larger on{" "}
                {VS_HUMAN.larger}, with the quartiles of the area ratio at {VS_HUMAN.q1}&times; and {VS_HUMAN.q3}
                &times;. Where the human wins on area, it is usually not by finding a better board under the same
                rules. Auditing every human layout against the solver&apos;s own physical constraints, with the
                solver&apos;s geometry code, shows {PHYSICS.violating} of the {CORPUS.projects} violating at least one:
                a flexible body inside a footprint&apos;s clearance (a resistor packed against the flank of an IC or
                connector) on {PHYSICS.onRigid} boards, parallel flexible bodies closer than the clearance permits
                on {PHYSICS.tooClose}, a flexible part bent tighter than its span minimum on {PHYSICS.spanShort}. Of
                the {VS_HUMAN.larger} projects where the human board is smaller,{" "}
                {PHYSICS.humanSmallerViolating} violate a physical rule. Against the{" "}
                {PHYSICS.cleanN} physically clean human boards the solver&apos;s median area ratio is{" "}
                {PHYSICS.cleanMedianRatio}&times;, against {PHYSICS.violatingMedianRatio.toFixed(2)}&times; on the
                violating ones, and only {PHYSICS.cleanHumanSmaller} clean boards are smaller than the solver&apos;s,
                none by more than a factor {PHYSICS.cleanWorstRatio}. In short, humans build tighter than the solver is allowed to: a
                resistor stood on end or laid flush against its neighbour is cheap in holes, and some of these boards
                were plausibly never soldered up to meet the consequences. Two caveats belong next to this. First, the
                audit reads hole positions, not the part that was soldered in. A generous span may hide a physically
                larger part, a power resistor in place of a quarter-watt one, that genuinely needed the room; the{" "}
                {PHYSICS.spanLong} boards stretching a part past its definition&apos;s span maximum are the visible
                cases, and on any such board the solver&apos;s tighter layout might not fit the real part. The stored
                data cannot distinguish a big part from a convenient layout of a small one, in either direction.
                Second, large projects nearly always contain at least one tight part; a single human board above 25
                parts is free of violations, so for the largest circuits the two explanations can barely be
                separated. In
                the small and mid
                bands, where both kinds of reference exist, the pattern holds clearly; in the 6 to 10 part band the
                solver&apos;s median is {PHYSICS.band6to10CleanMedian}&times; against clean references, and not one
                clean human board there is smaller.
              </P>
              <P>
                Two further runs, both under the portfolio, test the attribution directly. An <em>adaptive</em>{" "}
                relaxation grants the solver, per project and per part type, exactly the liberties that project&apos;s
                human demonstrably took: span ranges widen to cover the spans the human used, and clearances drop
                just far enough that the human&apos;s own placements become legal, never further. Boards whose human
                broke no rule solve identically, so the runs differ only where a liberty was granted. Every circuit
                still lays out completely, the median area ratio moves from {PORTFOLIO.areaRatio}&times; to{" "}
                {RELAXED.adaptive.areaRatio}&times;, and on the {RELAXED.adaptive.touchedN} boards where anything was
                granted the human&apos;s area wins fall from {RELAXED.adaptive.touchedHumanSmallerBaseline} to{" "}
                {RELAXED.adaptive.touchedHumanSmaller}. A <em>flat</em> relaxation, clearances removed and span minimums
                cut to one hole, bounds what the physical rulebook costs in total: a median of{" "}
                {RELAXED.flat.areaRatio}&times;, with {RELAXED.flat.smaller + RELAXED.flat.equal} of the{" "}
                {CORPUS.projects} boards at or below the human&apos;s area. Building tighter does cost tidiness; the
                relaxed runs end with {RELAXED.adaptive.offAxis} and {RELAXED.flat.offAxis} off-axis wires against
                the reference&apos;s {PORTFOLIO.offAxis}, since a board packed to the human&apos;s own density leaves
                the router less room to straighten its wires. The violations no constant can absolve, bodies
                crossing and corridors over pins, also remain in place, which is part of why some human wins remain.
              </P>
              <P>
                On wire tidiness the solver has moved past the reference. Across the corpus the humans left{" "}
                {HUMAN.offAxis} off-axis wires and {HUMAN.crossings} wire-over-part crossings; the portfolio leaves{" "}
                {PORTFOLIO.offAxis} and {PORTFOLIO.crossings}, and finishes{" "}
                {PORTFOLIO.cleanBoards} of {CORPUS.projects} boards with no wire defect at all against{" "}
                {HUMAN.cleanBoards} for the humans. It pays for this with wires, {PORTFOLIO.wires} against {HUMAN.wires},
                a {Math.round((PORTFOLIO.wires / HUMAN.wires) * 100 - 100)}% surplus, because a relayed pair of vertical
                wires counts twice where a human would accept one diagonal. Humans in turn use far more cuts,{" "}
                {HUMAN.cuts} against {PORTFOLIO.cuts}: they carve strips aggressively to buy same-strip sharing, which
                shows up again in the strip-complete share, {PORTFOLIO.stripCompletePct}% against{" "}
                {HUMAN.stripCompletePct}%. That is the clearest remaining structural difference between the two.
              </P>

              <Table n={3} caption="Median area relative to the human board, by project size. Small circuits come out well under the human's area; the mid bands are where honest clearance costs the most, and the portfolio is what pulls them back.">
                <thead>
                  <tr>
                    <Th>Parts</Th>
                    <Th right>n</Th>
                    <Th right>Single</Th>
                    <Th right>Portfolio</Th>
                  </tr>
                </thead>
                <tbody>
                  {SIZE_BANDS.map((b) => (
                    <tr key={b.band}>
                      <Td strong>{b.band}</Td>
                      <Td right>{b.n}</Td>
                      <Td right>{b.current.toFixed(2)}&times;</Td>
                      <Td right>{b.portfolio.toFixed(2)}&times;</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Sub>

            <Sub n="7.3" title="Ablations">
              <P>
                The tidy pass is measured on single-ordering runs, rows 1 and 2 of Table 2. With it disabled the
                corpus finishes with {FREE[0].offAxis} off-axis wires and {FREE[0].crossings} crossings, against{" "}
                {SINGLE.offAxis} and {SINGLE.crossings} with it, and{" "}
                {SINGLE.cleanBoards - FREE[0].cleanBoards} fewer boards end free of wire defects. The trade against
                size is small: the median area ratio moves three points ({FREE[0].areaRatio}&times; to{" "}
                {SINGLE.areaRatio}&times;), because the pass trims the blank lines its own insertions leave behind at
                the board edges and pays only for the room its channels actually use. What it costs is time, {RUNTIME.tidySharePct}% of the corpus-total solve time,
                concentrated in the largest boards; the median project pays about a quarter extra. This is the single
                largest quality lever in the pipeline and the reason it is on by default, with a checkbox for users
                who want the speed.
              </P>
              <P>
                The portfolio is the other large lever. Three orderings already buy back the tidy pass&apos;s area
                cost ({SINGLE.areaRatio}&times; to {FREE[2].areaRatio}&times;) while cutting wire defects from{" "}
                {SINGLE.offAxis + SINGLE.crossings} to {FREE[2].offAxis + FREE[2].crossings} at roughly three times
                the median solve time; per project, k = 3 is smaller on {PORTFOLIO_AB.k3vsSingle.better} boards and
                larger on {PORTFOLIO_AB.k3vsSingle.worse}. Ten orderings push both further: the
                median area ratio drops to {PORTFOLIO.areaRatio}&times;, wire defects fall again to{" "}
                {PORTFOLIO.offAxis} off-axis wires and {PORTFOLIO.crossings} crossings, and the count of fully clean
                boards rises to {PORTFOLIO.cleanBoards}. Against the single solve, k = 10 is smaller on{" "}
                {PORTFOLIO_AB.k10vsSingle.better} projects, identical on {PORTFOLIO_AB.k10vsSingle.same} and larger
                on {PORTFOLIO_AB.k10vsSingle.worse}; every one of those {PORTFOLIO_AB.k10vsSingle.worse} is a
                deliberate trade the rating prefers, not a regression; {PORTFOLIO_AB.k10LargerTidier} of them remove
                off-axis wires or crossings, and the other {PORTFOLIO_AB.k10LargerOtherGains} buy shorter or fewer
                wires and emptier channels. The largest, at +{PORTFOLIO_AB.k10LargerWorst.cells} cells, takes a board
                from {PORTFOLIO_AB.k10LargerWorst.defectsFrom} wire defects to{" "}
                {PORTFOLIO_AB.k10LargerWorst.defectsTo}. By construction no project can score worse.
              </P>
            </Sub>

            <Sub n="7.4" title="Constrained runs">
              <P>
                A second protocol locks two parts at their human positions, chosen deterministically as the largest
                connectors, and asks the solver to design around them. This is the hard case: the surrounding layout
                must conform to a position it did not choose.
              </P>
              <P>
                Early in the project this configuration completed only {LOCKED.baseline.complete} of the{" "}
                {LOCKED.baseline.of} circuits the corpus then contained, at {LOCKED.baseline.areaRatio}&times; human
                area. Every single failure had
                the same anatomy: a run of pins needing a link wire whose segment contained no free hole to solder it
                to. Enforcing the free hole as a structural invariant in the packer, rather than rescuing it afterwards,
                brought that to {LOCKED.current.complete}, the whole corpus. At a single ordering, locked runs cost{" "}
                {LOCKED.current.areaRatio}&times; human area against {SINGLE.areaRatio}&times; unconstrained, the
                price of a constraint the solver did not get to choose. The portfolio buys part of that premium back:
                under k = 10 the locked runs land at {LOCKED.portfolio.areaRatio}&times; the human area, about{" "}
                {Math.round((LOCKED.portfolio.areaRatio / PORTFOLIO.areaRatio - 1) * 100)}% more board than the same
                circuits solved free, with {LOCKED.portfolio.offAxis} off-axis wires and{" "}
                {LOCKED.portfolio.crossings} crossings over the comparison set, still well inside the humans&apos;{" "}
                {HUMAN.offAxis} and {HUMAN.crossings}. The residual premium is partly the lock itself and partly the
                physical rulebook: honest clearance bites hardest exactly where the layout cannot move a fixed part
                out of its own way.
              </P>
            </Sub>

            <Sub n="7.5" title="Where the residual defects live">
              <P>
                Residual wire defects are not spread evenly. Grouping projects by the rigid-join count <M tex="J" /> of
                equation (9) accounts for nearly all of them.
              </P>
              <Table n={4} caption="Residual wire defects by rigid-join count of the netlist, k = 10 portfolio. Boards whose ICs do not talk to each other come out almost universally perfect, with one outlier holding nearly all of that band's defects; the rest concentrate in the top band.">
                <thead>
                  <tr>
                    <Th>Rigid joins J</Th>
                    <Th right>Projects</Th>
                    <Th right>Off-axis</Th>
                    <Th right>Crossings</Th>
                  </tr>
                </thead>
                <tbody>
                  {JOIN_BANDS.map((b) => (
                    <tr key={b.band}>
                      <Td strong>{b.band}</Td>
                      <Td right>{b.n}</Td>
                      <Td right>{b.offAxis}</Td>
                      <Td right>{b.crossings}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <P>
                Nearly two thirds of the corpus has <M tex="J = 0" />, and of those {JOIN_BANDS[0].n} projects,{" "}
                {J0_OUTLIER.perfect} finish perfect and one more carries a single off-axis wire. The band&apos;s
                remaining defects, {J0_OUTLIER.offAxis} off-axis wires and all {J0_OUTLIER.crossings} of its
                crossings, belong to one {J0_OUTLIER.parts}-part outlier, a connector-dense board the solver clearly
                mishandles and which is worth a study of its own. Beyond that band, the defects sit in the{" "}
                {JOIN_BANDS[3].n} projects
                with eleven or more rigid joins, which are the IC-to-IC boards: several chips whose pin patterns are
                fixed, connected to each other by nets no flexible part can absorb by bending. What those boards need is
                horizontal transport, and a board with no pin-free copper spanning the required columns has nowhere to
                put it. The bus-lane mechanism of Section 4.5 provisions such rows on demand and closes part of the gap;
                the rest is open work.
              </P>
            </Sub>

            <Sub n="7.6" title="Runtime">
              <P>
                Times here and in Table 2 are wall-clock under the editor&apos;s own execution model: one circuit
                at a time on an otherwise idle machine, a portfolio&apos;s orderings running simultaneously in
                parallel worker threads, and every timed run verified to pick the same board as the corpus sweeps.
                Median time for a single ordering is {(RUNTIME.medianMs / 1000).toFixed(1)} s, with a
                90th percentile of {(RUNTIME.p90Ms / 1000).toFixed(1)} s and a worst case of{" "}
                {Math.round(RUNTIME.maxMs / 1000)} s, measured on {EVALUATED.hardware}. A typical desktop
                should be assumed a few times slower.
              </P>
              <Figure
                n={7}
                caption="Single-ordering wall-clock by project size, parts rounded to the nearest multiple of 5, over the corpus. Boxes span the interquartile range with a tick at the median; whiskers reach the extremes. The vertical scale is logarithmic: the medians climb from tens of milliseconds to tens of seconds across the bands, but the spread inside a band is itself one to two decades, so component count alone is a poor predictor of an individual circuit's solve time."
              >
                <FigRuntime />
              </Figure>
              <P>
                The figure explains why the median in Table 2 undersells the tail. Within every band the slowest
                project runs one to two orders of magnitude past the median, and the worst cases in the corpus are
                mid-sized boards of twenty-odd parts rather than the largest ones: what drives the annealing and
                routing cost is not the part count but how contested the board is, and a dense 20-part board with a
                large connector can cost more than a sparse 45-part one.
              </P>
              <P>
                Most of that time is candidate evaluation, not construction: the annealing refinement of Section 4.5
                re-derives a full completion for every candidate move, several thousand times on a large board. Two
                optimisations took the worst project in the corpus from 116 s to 7.7 s of solo runtime. A cheap ranking
                mode routes only the nets touched by the part being moved, with the
                exact evaluator used to re-measure the winner and a guard that reruns the whole search exactly whenever
                the cheap ranking might have hidden a starvation. And the wire-pricing search, which had been the
                dominant cost at scale, gained a column-bucketed obstacle index and a lower bound that prunes candidate
                hole pairs before the expensive geometry runs. Both were verified to leave every corpus output
                byte-identical.
              </P>
              <P>
                The portfolio multiplies this by <M tex="k" /> in total compute, but orderings solve in parallel
                across the workers, and the measurement above prices that directly: per project, the k = 10
                portfolio costs a median {RUNTIME.k10OverSingleMedian} times the single solve in wall-clock, not
                ten. The
                size-aware default of Section 6 exists for the tail: on the largest boards even one solve runs tens
                of seconds on an average machine, so the first click stays a single solve there and the larger
                portfolio is the user&apos;s explicit choice.
              </P>
            </Sub>
          </Section>

          <Section n="8" title="Comparison with the ASP formulation">
            <P>
              Li&apos;s ASP formulation [1] publishes results for five circuits, of which the guitar pedal is the one
              with a published schematic. I rebuilt that schematic in the editor as a netlist of {PEDAL.parts} parts
              and {PEDAL.nets} nets and verified that the editor&apos;s net inference reproduces the twelve nets of
              the original. The input and output jacks and the supply rails appear as schematic-only pins excluded
              from the board, mirroring the part list of the published layout. The reconstruction is public: the{" "}
              <a
                href={PEDAL.viewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--copper)] hover:underline"
              >
                live project
              </a>{" "}
              can be opened in the editor, solver output included.
            </P>

            <Table n={5} caption="The guitar-pedal benchmark. The ASP figure is as published; ours were measured on the reconstructed netlist. The ASP time is not comparable with the rest: the two systems ran on different hardware.">
              <thead>
                <tr>
                  <Th>Configuration</Th>
                  <Th right>Board</Th>
                  <Th right>Holes</Th>
                  <Th right>Cuts</Th>
                  <Th right>Wires</Th>
                  <Th right>Off-axis</Th>
                  <Th right>Cross</Th>
                  <Th right>Time</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td strong>ASP [1]</Td>
                  <Td right>
                    {PEDAL.asp.rows}&times;{PEDAL.asp.cols}
                  </Td>
                  <Td right>{PEDAL.asp.area}</Td>
                  <Td right>&ndash;</Td>
                  <Td right>{PEDAL.asp.wires}</Td>
                  <Td right>&ndash;</Td>
                  <Td right>&ndash;</Td>
                  <Td right>{PEDAL.asp.seconds}s</Td>
                </tr>
                {PEDAL.runs.map((r) => (
                  <tr key={r.label}>
                    <Td strong={r.label.startsWith("Portfolio")}>{r.label}</Td>
                    <Td right>
                      {r.rows}&times;{r.cols}
                    </Td>
                    <Td right strong={r.label.startsWith("Portfolio")}>
                      {r.area}
                    </Td>
                    <Td right>{r.cuts}</Td>
                    <Td right>{r.wires}</Td>
                    <Td right>{r.offAxis}</Td>
                    <Td right>{r.crossings}</Td>
                    <Td right>{r.seconds.toFixed(2)}s</Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <P>
              With the portfolio search the solver reaches {PEDAL.runs[1].area} holes against the published{" "}
              {PEDAL.asp.area}, a {Math.round((1 - PEDAL.runs[1].area / PEDAL.asp.area) * 100)}% smaller board, in{" "}
              {PEDAL.runs[1].seconds.toFixed(1)} s of wall clock. A single-ordering solve already produces{" "}
              {PEDAL.runs[0].area} holes in about half a second, below the published board as well.
            </P>
            <Figure
              n={8}
              caption={`The portfolio result on the reconstructed guitar-pedal netlist, as published in the editor: ${PEDAL.runs[1].rows}×${PEDAL.runs[1].cols} holes, twelve nets on ${PEDAL.runs[1].rows} strips through ${PEDAL.runs[1].cuts} cuts, ${PEDAL.runs[1].wires} link wires, every one vertical, none crossing a part. Click the board to open the live project.`}
            >
              <a href={PEDAL.viewUrl} target="_blank" rel="noopener noreferrer" title="Open the guitar-pedal project in the Stripboard Editor">
                <img
                  src="/Guitar-Pedal-(arXiv-2512.04910-benchmark).png"
                  alt="Automatically generated stripboard layout of the guitar-pedal benchmark circuit from arXiv 2512.04910: a compact stripboard with drilled strip cuts and only vertical link wires, produced by the Stripboard Editor's layout solver"
                  width={1252}
                  height={798}
                  className="w-full h-auto rounded border border-neutral-200 dark:hidden"
                />
                <img
                  src="/Guitar-Pedal-(arXiv-2512.04910-benchmark)-dark.png"
                  alt="Automatically generated stripboard layout of the guitar-pedal benchmark circuit from arXiv 2512.04910, dark mode: a compact stripboard with drilled strip cuts and only vertical link wires, produced by the Stripboard Editor's layout solver"
                  width={1252}
                  height={798}
                  className="w-full h-auto rounded border border-neutral-700 hidden dark:block"
                />
              </a>
            </Figure>

            <P>The comparison needs four qualifications, all favouring caution:</P>
            <ul className="font-serif text-[15px] leading-[1.75] text-neutral-700 dark:text-neutral-300 space-y-2 mb-3 list-disc pl-5">
              <li>
                <strong>The models differ in what they must satisfy.</strong> The ASP formulation defers strip cuts, so
                each of the twelve nets needs its own strip and the board is lower-bounded at twelve rows. My layouts
                cut strips, which lets ten or eleven strips carry twelve nets, and pay for it with the {PEDAL.runs[1].cuts}{" "}
                cuts and {PEDAL.runs[1].wires} wires the table reports. Cutting is the mechanism that makes stripboard
                compact, and it is exactly what that formulation postpones.
              </li>
              <li>
                <strong>The physical models differ.</strong> Their placement allows part spans of ten to eleven hole
                pitches with no body geometry or clearance. I enforce per-type span ranges and a clearance moat around
                every flexible body, which is a strictly harder constraint set. As a direct illustration: the published 12&times;18 layout itself
                is <em>infeasible</em> under my rules, with parts stretched past the span a real resistor allows; the
                area below it remains legally reachable, as the {PEDAL.runs[1].rows}&times;{PEDAL.runs[1].cols}{" "}
                result shows, but only by cutting strips.
              </li>
              <li>
                <strong>Timings are not comparable.</strong> Their {PEDAL.asp.seconds} s and my sub-second to{" "}
                {PEDAL.runs[1].seconds.toFixed(1)} s were measured on different machines with different software
                stacks. The useful observation is only that both are
                interactive-scale on a circuit of this size.
              </li>
              <li>
                <strong>One benchmark is one benchmark.</strong> The four other circuits in that work do not have
                published schematics I could reconstruct, and a single 18-part circuit cannot separate two systems.
                Table 2 is the substantive evaluation; this section is a point of contact with the only comparable
                published number I know of.
              </li>
            </ul>
            <P>
              The honest summary is that the two systems are not competing on the same problem. A declarative encoding
              buys an optimality argument within its model, and that is worth something my approach cannot offer. What
              it costs, on the evidence of that paper&apos;s own modelling choices, is the parts of the problem that are
              awkward to encode: cuts, clearance, locked parts and user-fixed board dimensions. Those are not
              refinements. On a corpus of real projects they are most of the work.
            </P>
          </Section>

          <Section n="9" title="Limitations and future work">
            <P>
              The solver offers no optimality guarantee and no bound. It constructs and repairs, and the portfolio of
              Section 6 is best understood as an admission that a single construction lands in an arbitrary local
              optimum. The measured spread across orderings on one circuit was {pedalMin} to {pedalMax} holes, which is
              a fair estimate of how much is left on the table by any single run.
            </P>
            <P>
              Known gaps, in rough order of how much they cost:
            </P>
            <ul className="font-serif text-[15px] leading-[1.75] text-neutral-700 dark:text-neutral-300 space-y-2 mb-3 list-disc pl-5">
              <li>
                <strong>IC-to-IC boards.</strong> The {JOIN_BANDS[3].n} projects with eleven or more rigid joins
                hold most of the remaining wire defects outside the single outlier of Section 7.5. Humans solve these
                with dedicated bus rows, one net per blank row,
                and with generous pitch between chips. The solver provisions bus rows opportunistically but does not
                plan them; doing so during stage 1, and biasing the packer towards wider IC pitch, is the clearest next
                lever.
              </li>
              <li>
                <strong>Pin grids the row model cannot represent.</strong> Stage 1 admits a rigid rotation only if
                each footprint row splits into at most two same-net blocks, one cut&apos;s worth. A part with three or
                more pin columns carrying three different nets in every rotation, the 3PDT stomp switch being the
                canonical case, has no admissible rotation at all and is left unplaced; it is the one incompletion in
                the full extraction of Section 7.1. The limitation is partly honest: such a switch&apos;s centre pin
                sits walled inside its own footprint, and even a human builds it by soldering a wire directly to the
                lug, which the solver only permits itself for user-locked parts. Representing multi-cut rows, and
                pricing lug-soldering instead of forbidding it, would close this class.
              </li>
              <li>
                <strong>Wires are straight.</strong> A link wire is a straight segment between its end holes
                (Section 2.3); the bent runs real builders use to slip past an obstacle exist neither in the editor
                nor in the solver. A bend is the wire-layer analogue of the relay of Section 4.4, one solder joint
                cheaper, so supporting it would give the router a better tool exactly where off-axis wires arise;
                but it starts in the editor&apos;s data model, not the solver.
              </li>
              <li>
                <strong>Locked parts disable channel insertion.</strong> Inserting a row or column shifts coordinates,
                which is not allowed when the user has pinned a part, so constrained runs get the tidy pass&apos;s
                economics but not its strongest mechanism. Insertion restricted to positions beyond the locked extent
                would recover part of this.
              </li>
              <li>
                <strong>Cut discipline.</strong> Humans use {Math.round((HUMAN.cuts / PORTFOLIO.cuts) * 100 - 100)}% more
                cuts than the solver and get more of their nets onto shared copper for it. Its strip-complete share sits
                at {PORTFOLIO.stripCompletePct}% against {HUMAN.stripCompletePct}% for the humans. Cutting more
                aggressively inside a tile is unexplored.
              </li>
              <li>
                <strong>Runtime on large boards.</strong> Candidate evaluation still dominates, and the largest projects
                take tens of seconds on fast hardware. The next structural step is incremental completion: only the rows
                a move touches change, yet segments, cuts and pin maps are currently rebuilt whole.
              </li>
              <li>
                <strong>Acceptance is measured by proxy.</strong> The stated goal is a board an experienced builder
                would accept, but no builder is asked in this report; the metrics of Section 7 stand in for that
                judgement, and they were chosen by the same person who tuned the solver. The editor now records how
                each applied layout is treated afterwards, kept, corrected or redone, which will support a direct
                acceptance measurement once enough usage has accumulated.
              </li>
              <li>
                <strong>Electrical intent is invisible to the solver.</strong> The netlist says which pins are
                connected, not why, and the solver optimises the graph it is given. Decoupling capacitors are the
                clearest casualty: four small capacitors on the same supply and ground nets are electrically
                interchangeable to the partitioner, which happily gathers them into one tight cluster, when the reason
                there are four of them rather than one large one is that each belongs next to a different chip. The
                resulting board is compact and correct as a netlist, and wrong as a circuit. Nothing in the objective
                distinguishes a bypass capacitor from any other two-pin part, and the same blindness applies to
                anything else whose position carries meaning the netlist does not record. Honouring it would need
                either a per-part affinity the user can state or a heuristic reading of part roles, and only the first
                is honest.
              </li>
            </ul>
          </Section>

          {/* References */}
          <section id="refs" className="mb-11 scroll-mt-16">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-4">References</h2>
            <ol className="font-serif text-[14px] leading-relaxed text-neutral-600 dark:text-neutral-400 space-y-2">
              <li>
                [1] Fang Li. <em>Declarative Synthesis and Multi-Objective Optimization of Stripboard Circuit Layouts
                Using Answer Set Programming.</em> arXiv:2512.04910, December 2025.{" "}
                <a
                  href="https://arxiv.org/abs/2512.04910"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  arxiv.org/abs/2512.04910
                </a>
              </li>
              <li>
                [2] Stripboard Editor source.{" "}
                <a
                  href="https://github.com/KarloFunke/stripboard-editor"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  github.com/KarloFunke/stripboard-editor
                </a>
              </li>
              <li>
                [3] Roger Dahl. <em>Stripboard Autorouter.</em> MIT licence, 2016 to 2022.{" "}
                <a
                  href="https://github.com/rogerdahl/striprouter-cpp"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  github.com/rogerdahl/striprouter-cpp
                </a>
              </li>
              <li>
                [4] Alex Lawrow. <em>VeroRoute.</em> GPLv3, version 2.40, 2017 to 2026.{" "}
                <a
                  href="https://sourceforge.net/projects/veroroute/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  sourceforge.net/projects/veroroute
                </a>
              </li>
              <li>
                [5] Charles J. Alpert and Andrew B. Kahng. <em>Recent directions in netlist partitioning: a
                survey.</em> Integration, the VLSI Journal 19 (1995), 1&ndash;81.{" "}
                <a
                  href="https://doi.org/10.1016/0167-9260(95)00008-4"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--copper)] hover:underline"
                >
                  doi.org/10.1016/0167-9260(95)00008-4
                </a>
              </li>
            </ol>
          </section>

          <Section n="A" title="Notation">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] border-collapse mb-2">
                <tbody>
                  {[
                    ["R,\\;C", "board rows and columns; row r is one copper strip"],
                    ["\\tilde{R},\\;\\tilde{C}", "effective dimensions, charging a locked dimension in full"],
                    ["\\sigma(h)", "the segment (uncut run of holes) containing hole h"],
                    ["\\varphi(v)", "the hole occupied by pin v"],
                    ["\\nu(v)", "the net of pin v"],
                    ["\\Gamma_n", "copper groups of net n: the distinct segments its pins occupy"],
                    ["W", "link wires; W_n those joining two groups of net n"],
                    ["q(L)", "defect count of a finished layout, equation (6)"],
                    ["b(L)", "defect count used during search, equation (10)"],
                    ["x(w)", "extra effective length charged to wire w, equation (11)"],
                    ["\\tau(w)", "channel stacking charge of wire w (Section 5.2)"],
                    ["\\lambda_A", "price of one board cell, in holes of wire (Section 5.3)"],
                    ["M(L)", "wire mess, equation (12)"],
                    ["A(R,C)", "aspect penalty, equation (14)"],
                    ["s(L)", "number of off-axis wires"],
                    ["S(L)", "portfolio rating of a finished layout, equation (16)"],
                    ["J", "rigid joins: IC-to-IC net connections, equation (9)"],
                  ].map(([tex, desc]) => (
                    <tr key={tex}>
                      <td className="border-b border-neutral-100 dark:border-neutral-800 py-1.5 pr-4 align-top w-28">
                        <M tex={tex} />
                      </td>
                      <td className="border-b border-neutral-100 dark:border-neutral-800 py-1.5 font-serif text-neutral-600 dark:text-neutral-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section n="B" title="Reproducibility">
            <P>
              The solver is open source [2] and runs entirely in the browser. Every configuration in this report runs
              a fixed number of orderings and is therefore deterministic: the same netlist gives the same board. The
              editor&apos;s shipped default is itself a fixed count (Section 6), so it reproduces exactly on any
              machine; an earlier revision used a time budget, whose results depended on the hardware that computed
              them. The benchmark harness that produced the corpus tables ships with the source at{" "}
              <Code>tests/solver/sweep.js</Code>, its aggregation at <Code>tests/solver/paperStats.js</Code>, and
              takes the corpus location as an argument.
            </P>
            <P>
              The corpus itself is not published and will not be. It consists of projects belonging to the editor&apos;s
              users, and it is used only in aggregate and only on the maintainer&apos;s machine; nothing in this report
              identifies a project, and no user circuit is reproduced anywhere in it. The guitar-pedal benchmark of
              Section 8 is the exception, being reconstructed from a published figure, and is the one case where a
              specific circuit can be shared.
            </P>
            <P>
              Measurements dated {EVALUATED.date}, taken at source revision <Code>{EVALUATED.commit}</Code> [2]. For a
              non-technical description of the same machinery, see{" "}
              <Link href="/guide/auto-layout" className="text-[var(--copper)] hover:underline">
                How Auto-layout Works
              </Link>
              .
            </P>
          </Section>

          <Section n="C" title="Beam search over constructions">
            <P>
              This appendix records an alternative to the portfolio of Section 6 that was measured and rejected. The
              ladder of Section 4.3 builds several complete constructions of the same circuit and refines exactly one
              of them. Beam search over constructions refines all of them instead: the ladder&apos;s pool holds{" "}
              {BEAM.poolMedian} distinct constructions per circuit at the median, between {BEAM.poolMin} and{" "}
              {BEAM.poolMax}, each is carried through refinement and the tidy pass, and the best finished board is
              chosen by (16), with the normal path winning ties. It composes with input orderings, so a portfolio of
              orderings with a full beam on each is also available. Every configuration below was measured at the
              same revision and under the same protocol as Table 2.
            </P>
            <P>
              The alternative constructions are genuinely different boards: refining all of them changes the finished
              result on {BEAM.vsSingle.smaller + BEAM.vsSingle.larger} of the {CORPUS.projects} circuits against the
              plain solve of the same ordering, smaller on {BEAM.vsSingle.smaller} and larger on{" "}
              {BEAM.vsSingle.larger}. What they are not is systematically better: the median area ratio against the
              plain solve is exactly {BEAM.vsSingleMedianRatio.toFixed(2)}, so the extra four-odd solves buy nothing
              at the median project. Against the portfolio the comparison is one-sided in three separate ways.
            </P>

            <Table n={6} caption={`Beam search over constructions against the portfolio, over the same ${CORPUS.projects} circuits, protocol and metrics as Section 7. A beam refines every distinct construction of one ordering, about five solves, set by the circuit rather than chosen; the last row runs a full beam on each of three orderings. Every row uses the shipped guarded pick except "guard off", which ablates it (its solves are the k = 10 row's own, so its time is too). Time is the median wall-clock per project under the protocol of Section 7.6: orderings run in parallel workers, while a beamed solve refines its pool sequentially, as shipped.`}>
              <thead>
                <tr>
                  <Th>Configuration</Th>
                  <Th right>Solves</Th>
                  <Th right>Area</Th>
                  <Th right>Aspect</Th>
                  <Th right>Off-axis</Th>
                  <Th right>Cross</Th>
                  <Th right>Clean</Th>
                  <Th right>Time</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Single ordering", solves: "1", c: SINGLE },
                  { label: "Beam, full pool", solves: "~5", c: BEAM.pool },
                  { label: "Portfolio, k = 5", solves: "5", c: BEAM.perm5 },
                  { label: "Portfolio, k = 10", solves: "10", c: PORTFOLIO },
                  { label: "Portfolio, k = 10, guard off", solves: "10", c: BEAM.p10Unguarded },
                  { label: "Portfolio, k = 3, beam each", solves: "~15", c: BEAM.mixed },
                ].map((r) => (
                  <tr key={r.label}>
                    <Td>{r.label}</Td>
                    <Td right>{r.solves}</Td>
                    <Td right>{r.c.areaRatio.toFixed(2)}&times;</Td>
                    <Td right>{r.c.aspect.toFixed(2)}</Td>
                    <Td right>{r.c.offAxis}</Td>
                    <Td right>{r.c.crossings}</Td>
                    <Td right>{r.c.cleanBoards}</Td>
                    <Td right>{(r.c.msMedian / 1000).toFixed(1)}s</Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <P>
              <strong>Tidiness.</strong> At an equal number of solves the beam matches the five-ordering
              portfolio on area, {BEAM.pool.areaRatio}&times; the human board for both, and loses everywhere else:{" "}
              {BEAM.pool.offAxis} off-axis wires against {BEAM.perm5.offAxis}, {BEAM.pool.crossings} crossings
              against {BEAM.perm5.crossings}, and twice the boards stretched past three to one. The
              reason is what each source of variance hands to the tidy pass. A fresh ordering hands it a fresh
              construction to straighten; a beam survivor re-mines the neighbourhood of one construction, and what it
              finds there is density, not tidiness. Nor does combining the two buy anything: three orderings
              with a full beam each land at a median {BEAM.mixed.areaRatio}&times; against the plain ten-ordering
              portfolio&apos;s {PORTFOLIO.areaRatio}&times;, split roughly evenly per project ({BEAM.mixedVsPortfolio.smaller}{" "}
              smaller against {BEAM.mixedVsPortfolio.larger} larger), while still paying in
              exactly the currency this solver spends its effort on: {BEAM.mixed.offAxis} off-axis wires and{" "}
              {BEAM.mixed.crossings} crossings against the portfolio&apos;s {PORTFOLIO.offAxis} and{" "}
              {PORTFOLIO.crossings}, with {PORTFOLIO.cleanBoards - BEAM.mixed.cleanBoards} more boards losing their
              freedom from wire defects, and a shape distribution the next paragraph takes up. An earlier revision of
              this appendix, on an earlier corpus revision, still found the mixed beam ahead on area; with the
              possibly-solver-aided boards removed from the reference set, even that advantage is gone.
            </P>
            <P>
              <strong>Shape.</strong> The density is partly bought with a proportion the rating does not price. The
              number of boards longer than three to one rises from {PORTFOLIO.aspectOver3} under the portfolio to{" "}
              {BEAM.mixed.aspectOver3} under the mixed beam, and {BEAM.pool.aspectOver3} under a single beamed
              ordering;{" "}
              {BEAM.squareToStrip} circuits that the portfolio lays out squarely, at an aspect of two or less, come out
              of the beam as strips. The extreme case goes from {BEAM.worstFlip.fromRows}&times;
              {BEAM.worstFlip.fromCols} to {BEAM.worstFlip.toRows}&times;{BEAM.worstFlip.toCols}, saving{" "}
              {BEAM.worstFlip.fromArea - BEAM.worstFlip.toArea} holes for a board that no longer fits a normal
              enclosure. This follows directly from (16), which charges trimmed area and drops the aspect penalty
              deliberately, so a long thin board that saves area outranks a square one. It is not the beam that
              wants strips; the beam merely surfaces constructions extreme enough for the omission to matter, which the
              ordering portfolio rarely does. The portfolio itself stays just inside human practice here, at{" "}
              {PORTFOLIO.aspectOver3} boards past three to one against the corpus&apos;s {HUMAN.aspectOver3} human
              ones; the beam takes the output past it, which is a change in the shape of the result that no user
              asked for.
            </P>
            <P>
              <strong>Cost.</strong> One beamed ordering costs a median of {BEAM.msVsSingleMedian}&times; the
              compute of a plain solve,
              a P90 of {BEAM.msVsSingleP90}&times; and up to {BEAM.msVsSingleMax}&times;, with the slowest single
              beamed ordering in the corpus taking {BEAM.slowestOrderingSeconds} seconds. In the wall-clock a user
              feels the gap is larger still, because orderings spread over parallel workers while the shipped beam
              refines its pool one entry after another: at matched solve counts the beam takes a median{" "}
              {BEAM.msVsPerm5Median}&times; as long as the five-ordering portfolio, a
              P90 of {BEAM.msVsPerm5P90}&times;, and is more than twice as slow on {BEAM.msVsPerm5Over2x} of the{" "}
              {CORPUS.projects} circuits. Part of
              that gap is an artefact of the implementation: pool entries are independent and could spread over
              workers too, and the beam reruns stages 0 to 3 for each entry instead of
              resuming from the stored construction, both recoverable. The rest is not: the entries
              that survive into the pool are the larger constructions, and refining a larger board costs more, so
              even a parallel beam would be paced by its slowest entry. The
              structural problem is worse than the constant. A portfolio spends exactly what the user asked for,
              because the number of orderings is the setting itself, whereas a pool&apos;s size is a property of the
              circuit: every entry must be finished before any of them can be rated, so the cost of a beamed solve is
              neither predictable nor adjustable. The size-aware default of Section 6, which trims the portfolio on
              large projects precisely to keep a first run quick, has no counterpart a beam could offer.
            </P>
            <P>
              The shipped configuration therefore searches over input orderings only, and the option is not reachable
              from the editor. One piece of the experiment does deserve to outlive it. The guarded pick is independent
              of the beam, and its effect on the plain portfolio is unusually concentrated: turning it off changes
              only {BEAM.guardChanged} of the {CORPUS.projects} boards and leaves the rest untouched. On those{" "}
              {BEAM.guardChanged} the guard removes {BEAM.p10Unguarded.crossings - PORTFOLIO.crossings} crossings,
              and every one of them grows, by{" "}
              {BEAM.guardHoles} holes in total; the median board is untouched, so the two rows&apos; area ratios
              differ by a single point. The extreme case goes from {BEAM.guardWorst.fromRows}&times;{BEAM.guardWorst.fromCols} to{" "}
              {BEAM.guardWorst.toRows}&times;{BEAM.guardWorst.toCols}, a quarter more area, to take that board from{" "}
              {BEAM.guardWorst.crossingsFrom} crossings to {BEAM.guardWorst.crossingsTo}. Whether that is a good trade
              is a judgement about what a builder minds more rather than a measurement, and it was initially left on
              the shelf for exactly that reason. Building a real board from the solver&apos;s output settled the
              judgement; on the bench a wire over a part costs far more attention than a few spare holes. The
              guarded pick is now part of the shipped final pick of Section 6.
            </P>
          </Section>
        </article>
      </div>

      <SiteFooter />
    </div>
  );
}
