import type { Metadata } from "next";
import type { ReactNode } from "react";
import SiteHeader from "@/components/SiteHeader";
import ReadDepth from "@/components/ReadDepth";
import TrackedLink from "@/components/TrackedLink";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Guide",
  description:
    "A quick guide to the Stripboard Editor covering keyboard shortcuts, workflow, the automatic layouter, KiCad netlist export, and key concepts.",
  alternates: { canonical: "https://stripboard-editor.com/guide" },
};

const K = ({ children }: { children: ReactNode }) => (
  <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">{children}</kbd>
);
const H2 = ({ children }: { children: ReactNode }) => (
  <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">{children}</h2>
);
const H3 = ({ children }: { children: ReactNode }) => (
  <h3 className="font-mono text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-5 mb-2">{children}</h3>
);
const UL = ({ children }: { children: ReactNode }) => (
  <ul className="space-y-1.5 text-sm text-neutral-700 dark:text-neutral-300 list-disc pl-5">{children}</ul>
);

const SHORTCUTS: [string, [string, string][]][] = [
  ["Both editors", [
    ["W", "Wire tool on and off"],
    ["R", "Rotate the selection"],
    ["Delete", "Remove the selection"],
    ["Escape", "Cancel, then clear the selection, then put the tool away"],
    ["Arrow keys", "Move the selection one step (Shift: five)"],
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y / Ctrl + Shift + Z", "Redo"],
    ["Right-click drag", "Pan the canvas"],
    ["Scroll wheel", "Zoom in / out"],
  ]],
  ["Schematic", [
    ["G / P", "Ground flag / power flag at the cursor"],
    ["L", "Net label at the cursor"],
    ["M", "Mirror the selection"],
    ["E", "Exclude / include the selected parts on the stripboard"],
    ["Enter / Backspace", "While drawing a wire: finish it / take the last segment back"],
    ["Alt + Delete", "Remove whole wires, all segments included"],
    ["Ctrl + click / Shift + click", "Toggle / add to the selection"],
    ["Ctrl + A", "Select everything"],
    ["Ctrl + C / Ctrl + V / Ctrl + D", "Copy, paste at the cursor, duplicate"],
  ]],
  ["Stripboard", [
    ["C", "Cut tool on and off"],
    ["L", "Lock / unlock the selected parts for auto-layout"],
    ["Right-click", "Insert or delete the row / column under the pointer"],
  ]],
];

export default function GuidePage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="quick_guide" />
      <ReadDepth page="guide" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
        <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">Quick Guide</h1>

        <section className="mb-10">
          <H2>Workflow</H2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li><strong>Design the schematic</strong> on the left. Add components from the library and draw wires between pins to define nets.</li>
            <li><strong>Place components on the stripboard</strong> on the right. Drag them from the unplaced tray onto the board.</li>
            <li><strong>Resolve conflicts.</strong> Place cuts to isolate strips and add wires to connect separated nets.</li>
            <li><strong>Done.</strong> When all nets are complete and there are no conflicts, you are ready to solder.</li>
          </ol>
        </section>

        <section className="mb-10">
          <img
            src="/demo-circuit.png"
            alt="Example finished circuit with schematic and stripboard"
            className="rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm dark:shadow-neutral-900/30 w-full dark:hidden"
          />
          <img
            src="/demo-circuit-dark.png"
            alt="Example finished circuit with schematic and stripboard"
            className="rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm dark:shadow-neutral-900/30 w-full hidden dark:block"
          />
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-2 text-center">A finished project: schematic on the left, stripboard layout on the right.</p>
        </section>

        <section className="mb-10">
          <H2>Schematic Editor (left)</H2>

          <H3>Adding parts and wires</H3>
          <UL>
            <li>Drag components from the library onto the canvas. <strong>+ Create Custom Component</strong> at the bottom of the library makes your own; it is saved with the project.</li>
            <li>Click a pin end to start a wire, then click pins, wires or grid points to route it. The wire tool (<K>W</K>) also starts wires on empty grid.</li>
            <li>Click a component label or a pin label to rename it. Drag labels out of the way.</li>
          </UL>

          <H3>What counts as connected</H3>
          <UL>
            <li>Whatever touches is connected: a wire end on a wire, a pin on a wire, two pins on one point. Wires that only cross stay separate.</li>
            <li>A dot marks a junction, a small hollow square a loose wire end.</li>
            <li>Connected pins form a net. Rename or recolour nets in the sidebar.</li>
          </UL>

          <H3>Flags and net labels</H3>
          <UL>
            <li>Ground and power flags (<K>G</K> / <K>P</K>) and net labels (<K>L</K>) join everything of the same name into one net, so GND and VCC need no wires across the sheet. Double-click a flag to rename it.</li>
          </UL>

          <H3>Selecting and editing</H3>
          <UL>
            <li>Click selects, <K>Ctrl</K> + click toggles, <K>Shift</K> + click adds. Wires are selected and moved like parts.</li>
            <li>A box dragged left to right selects what it encloses, right to left everything it touches.</li>
          </UL>

          <H3>Parts that are not on the board</H3>
          <UL>
            <li><strong>Mount off board</strong> (floating menu) is for pots, switches and jacks on the enclosure. The board gets solder pads or a connector for their wires instead of the part.</li>
            <li><strong>Exclude</strong> (<K>E</K>) keeps a part in the schematic but ignores it on the board and in its net checks, so you can draw a full circuit and build only part of it.</li>
          </UL>

          <details className="mt-5 rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 px-3 py-2 [&[open]]:pb-3">
            <summary className="cursor-pointer text-xs font-mono text-[var(--copper)] hover:underline marker:text-neutral-400">
              Older projects and the Classic wiring link
            </summary>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-3">
              Schematics drawn before touching meant connected follow the rules they were drawn under, where only wire ends connect. Drawings that mean the same under both sets of rules were switched over for you. The rest show a <em>Classic wiring</em> link in the schematic header that previews every change the switch would make and applies it. The switch is optional, and undoable.
            </p>
          </details>
        </section>

        <section className="mb-10">
          <H2>Stripboard Editor (right)</H2>

          <H3>Placing parts</H3>
          <UL>
            <li>Drag components from the <em>Unplaced</em> tray onto the board. Strips take the colour of the net on them; a red strip carries two nets and needs a cut.</li>
            <li>2-pin parts like resistors and LEDs have flexible leads. Drag a single pin to reshape them.</li>
            <li>A part that puts two of its pins on one strip, like an IC, brings the cuts between them when you place it. They move with the part and leave with it.</li>
            <li>Hover an incomplete net in the sidebar to highlight its strips.</li>
          </UL>

          <H3>The tools: select, wire, cut</H3>
          <UL>
            <li>The tools on the left edge of the board decide what a click does. <K>Esc</K> always returns to select.</li>
            <li><strong>Wire</strong> (<K>W</K>): click a hole, then another. Wires already in a hole are ignored, so a chain can hop on from the same hole.</li>
            <li><strong>Cut</strong> (<K>C</K>): click a hole to drill it out, or between two holes to cut the copper there. It works under parts too. Click a cut again to remove it.</li>
            <li><strong>Select</strong>: move parts, and click a wire or a cut to drag or delete it. Drag a wire end to move just that end.</li>
          </UL>

          <H3>Rows and columns</H3>
          <UL>
            <li><strong>Right-click</strong> anywhere on the board to insert or delete the row or column there. Deleting unplaces parts that sit on the line; whatever only spans it shrinks.</li>
          </UL>

          <H3>Footprints and packages</H3>
          <UL>
            <li>Select a placed part and use the floating menu: <strong>Package</strong> picks the real body (a 1/4 W or 1/2 W resistor, TO-92 or TO-220), <strong>Edit Footprint</strong> resizes the grid and moves pins of ICs and connectors to match your physical part.</li>
          </UL>
        </section>

        <section className="mb-10">
          <H2>Auto-layout</H2>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
            Click <strong>Auto-layout</strong> above the unplaced tray. The layouter places every part, picks the board size, and adds the cuts and link wires. If anything cannot be completed, a pop-up tells you what and why.
          </p>
          <UL>
            <li><strong>Lock the board size.</strong> Click the padlock next to <em>Rows</em> or <em>Cols</em> to keep exactly that many. A locked board cannot grow, so a few slanted or crossing wires may remain.</li>
            <li><strong>Lock parts.</strong> Select placed parts and press <K>L</K> to keep them where they are. Locked layouts come out a little larger.</li>
            <li><strong>Settings</strong> (gear beside the button): standing parts, extra room between parts, drilled cuts only, no stacked wires, how many layouts to solve, and the anneal effort per layout. Each option explains itself in the panel.</li>
          </UL>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 mt-3">
            Curious how it decides all this? <TrackedLink from="guide" to="explainer" href="/how-auto-layout-works" className="text-[var(--copper)] hover:underline font-semibold">How auto-layout works &rarr;</TrackedLink>
          </p>
        </section>

        <section className="mb-10">
          <H2>Printing &amp; Assembly</H2>
          <UL>
            <li><strong>Print</strong> in the project toolbar builds an assembly guide. Print at 100% and check the calibration ruler, so the holes match real stripboard.</li>
            <li>The <strong>component sheet</strong> shows the top side: lay it on the board and push the leads through. The <strong>cut sheet</strong> is mirrored for the copper side and marks every cut with an <span aria-hidden="true">✕</span>.</li>
            <li>The <strong>BOM</strong> lists quantities, values and reference labels; off-board parts get a wiring table.</li>
            <li>Options: colour or black and white, reference and pin labels, and a <strong>view</strong> or <strong>edit</strong> QR code back to the project.</li>
          </UL>
        </section>

        <section className="mb-10">
          <H2>Exporting</H2>
          <UL>
            <li><strong>Export &rarr; Raw project</strong> downloads the whole project as a JSON file. Bring it back from the <strong>Import</strong> menu.</li>
            <li><strong>Export &rarr; Netlist</strong> writes a KiCad netlist with your parts, values, pin numbers and nets, so a prototype can become a PCB. Most parts map to stock KiCad footprints; the rest come as a small footprint library in the same zip. Add it once under <em>Preferences &rarr; Manage Footprint Libraries</em> with the nickname shown in the pop-up.</li>
            <li>A netlist holds connections, not drawings, and importing one is not supported yet.</li>
          </UL>
        </section>

        <section className="mb-10">
          <H2>Saving &amp; Sharing</H2>
          <UL>
            <li>No account is required. The first save gives you a unique link; bookmark it to come back to the project.</li>
            <li>An account collects all your projects in one dashboard and adds sharing: an edit link for full access and a view-only link.</li>
            <li>Anyone viewing a shared project can <strong>fork</strong> it into their own editable copy.</li>
          </UL>
        </section>

        <section>
          <H2>Keyboard Shortcuts</H2>
          {SHORTCUTS.map(([group, rows]) => (
            <div key={group}>
              <H3>{group}</H3>
              <div className="space-y-1.5 text-sm">
                {rows.map(([key, desc]) => (
                  <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono text-neutral-800 dark:text-neutral-200 whitespace-nowrap min-w-[100px] shrink-0 text-center">
                      {key}
                    </kbd>
                    <span className="min-w-0 text-neutral-600 dark:text-neutral-400">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
