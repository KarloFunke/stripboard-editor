import type { Metadata } from "next";
import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Guide",
  description:
    "A quick guide to the Stripboard Editor covering keyboard shortcuts, workflow, and key concepts.",
  alternates: { canonical: "https://stripboard-editor.com/guide" },
};

export default function GuidePage() {
  return (
    <div className="min-h-screen font-mono bg-[#fafafa] dark:bg-[#121212] bg-[radial-gradient(var(--page-dot)_1px,transparent_1.5px)] [background-size:24px_24px] flex flex-col">
      <SiteHeader breadcrumb="quick_guide" />

      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm dark:shadow-neutral-900/30 px-5 sm:px-8 py-7 sm:py-9">
        <h1 className="font-mono text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6 tracking-tight">Quick Guide</h1>

        {/* Steps */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Workflow</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li><strong>Design the schematic</strong> on the left. Add components from the library and draw wires between pins to define nets.</li>
            <li><strong>Place components on the stripboard</strong> on the right. Drag them from the unplaced tray onto the board.</li>
            <li><strong>Resolve conflicts.</strong> Place cuts to isolate strips and add wires to connect separated nets.</li>
            <li><strong>Done.</strong> When all nets are complete and there are no conflicts, you are ready to solder.</li>
          </ol>
        </section>

        {/* Screenshot placeholder */}
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

        {/* Schematic Editor */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Schematic Editor (left)</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Drag components from the library sidebar onto the canvas.</li>
            <li>Press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">W</kbd> to enter wire drawing mode, then click pins to connect them.</li>
            <li>Connected pins automatically form a net. Rename or recolour nets in the sidebar.</li>
            <li>Click a component label to rename it. Click a pin label to rename the pin.</li>
            <li>Drag labels and pin labels to reposition them if they overlap with wires.</li>
            <li>Select one or more components and press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">E</kbd> (or use <strong>Exclude</strong> in the floating menu) to keep them off the stripboard. Excluded parts stay in the schematic but are ignored by the board and its net checks, so you can draw a full circuit while only building part of it. Press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">E</kbd> again to include them back.</li>
            <li>Use the footprint editor (on the stripboard side) to customise a component{"'"}s physical layout.</li>
          </ul>
        </section>

        {/* Stripboard Editor */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Stripboard Editor (right)</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Drag components from the <em>Unplaced</em> tray onto the board.</li>
            <li>Strips automatically colour to match the net of the pin sitting on them.</li>
            <li>Red highlighted strips indicate a conflict where two different nets share the same strip.</li>
            <li>Place a <strong>cut</strong> to isolate the strip into sections: click between two holes, or hold <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">Alt</kbd> and click a hole to cut the strip at the hole itself.</li>
            <li>Click a hole then another hole to place a <strong>wire</strong> connecting them. Click an existing wire to delete it.</li>
            <li>A hole holds either a cut or a wire, never both. Click a hole cut to remove it (no <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">Alt</kbd> needed).</li>
            <li>2-pin passive components (resistors, LEDs, etc.) have flexible leads. Drag individual pins to reshape them.</li>
            <li>Non-flexible components (ICs, connectors, etc.) can have their footprint edited. Select a placed component, then click <strong>Edit Footprint</strong> in the floating menu above it. You can resize the grid and move pins around to match your physical component.</li>
            <li>Hover over an incomplete net in the sidebar to highlight the relevant strips.</li>
          </ul>
        </section>

        {/* Auto-layout */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">
            Auto-layout <span className="text-neutral-400 dark:text-neutral-500 normal-case tracking-normal">(alpha)</span>
          </h2>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">
            Click <strong>Auto-layout</strong> in the stripboard toolbar to have the router arrange every part for you. It reads your schematic nets, places the components, picks a board size, and generates the strip cuts and link wires needed to complete the board. The router is deterministic, so the same circuit always produces the same layout, and it respects the physical reality of the parts (for example, it will not push two through-hole resistor bodies closer than they can actually sit). A short summary of what it did appears in a pop-up when it finishes.
          </p>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-2">You stay in control of two things:</p>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li><strong>Lock the board size.</strong> Click the padlock next to the <em>Rows</em> or <em>Cols</em> field to fix that dimension. Auto-layout then keeps exactly that many rows or columns, so you can constrain the result to a board you already own (for example, exactly 20 columns wide). Leave a dimension unlocked and the router chooses it freely. If a locked size is too small to fit the circuit, it tells you rather than silently overflowing.</li>
            <li><strong>Lock components in place.</strong> Position a part where you want it (a connector along an edge, say), select it, and press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">L</kbd> (or use <strong>Lock</strong> in the floating menu). Auto-layout will never move a locked part; instead it designs the surrounding layout around it. Select several parts and press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">L</kbd> to lock them all at once. Locking works, but expect a locked layout to come out somewhat larger or less tidy than an unconstrained one.</li>
          </ul>
          <p className="text-sm text-neutral-700 dark:text-neutral-300 mt-3">
            Curious how it decides all this? <Link href="/guide/auto-layout" className="text-[var(--copper)] hover:underline font-semibold">How auto-layout works &rarr;</Link>
          </p>
          <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-3">The router is in alpha. It solves the layouts we test well, but expect the odd result you will want to tidy by hand, and please send feedback on anything it gets wrong.</p>
        </section>

        {/* Printing & Assembly */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Printing &amp; Assembly</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Click <strong>Print</strong> in the project toolbar to open the print / PDF dialog and generate an assembly guide.</li>
            <li>The <strong>component sheet</strong> shows the board from the component side. Lay it on top and push leads through the marked holes.</li>
            <li>The <strong>cut sheet</strong> is mirrored for the copper side and marks every track cut with an <span aria-hidden="true">✕</span>.</li>
            <li>The <strong>BOM</strong> (bill of materials) lists quantities, values, and reference labels for sourcing parts.</li>
            <li>Toggle reference labels, wires, cuts, and pin labels to tailor each sheet to your build.</li>
            <li>Optionally add a <strong>view</strong> or <strong>edit</strong> QR code that links back to the online project.</li>
            <li>Print at 100% / actual size and verify the calibration ruler so hole spacing matches real stripboard.</li>
          </ul>
        </section>

        {/* Keyboard Shortcuts */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Keyboard Shortcuts</h2>
          <div className="space-y-1.5 text-sm">
            {[
              ["R", "Rotate selected component"],
              ["L", "Lock / unlock selected component(s) so auto-layout keeps them in place (stripboard)"],
              ["M", "Mirror selected component (schematic)"],
              ["E", "Exclude / include selected component(s) on the stripboard (schematic)"],
              ["W", "Toggle wire drawing mode (schematic)"],
              ["Ctrl + C / Ctrl + V", "Copy and paste selected component (schematic)"],
              ["Delete", "Remove selected component or wire"],
              ["Escape", "Cancel current action or exit wire mode"],
              ["Ctrl + Z", "Undo"],
              ["Ctrl + Y / Ctrl + Shift + Z", "Redo"],
              ["Arrow keys / Drag", "Move selected components, one or many"],
              ["Alt + click hole", "Cut the strip at a hole (stripboard)"],
              ["Right-click drag", "Pan the canvas"],
              ["Scroll wheel", "Zoom in / out"],
            ].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-3">
                <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono text-neutral-800 dark:text-neutral-200 whitespace-nowrap min-w-[100px] text-center">
                  {key}
                </kbd>
                <span className="text-neutral-600 dark:text-neutral-400">{desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Custom Components */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Custom Components</h2>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Click <strong>+ Create Custom Component</strong> at the bottom of the library.
            Define the grid size, place pins, and assign names. Your custom components are saved with the project
            and appear in a dedicated <em>Custom</em> section.
          </p>
        </section>

        {/* Saving & Sharing */}
        <section className="mb-10">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--copper)] mb-3">Saving &amp; Sharing</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>No account is required. When you save a project for the first time, a unique link is generated. Bookmark or save this link to return to your project later.</li>
            <li>You can also export your project as a JSON file and re-import it at any time.</li>
            <li>Creating an account lets you access all your projects from a central dashboard without needing to save individual links.</li>
            <li>Logged-in users can share projects. Each project has an edit link for full access and a separate view-only link for sharing with others.</li>
            <li>Anyone viewing a shared project can <strong>fork</strong> it to create their own editable copy.</li>
          </ul>
        </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
