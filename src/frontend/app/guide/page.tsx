import type { Metadata } from "next";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Quick Guide",
  description:
    "A quick guide to the Stripboard Editor covering keyboard shortcuts, workflow, and key concepts.",
  alternates: { canonical: "https://stripboard-editor.com/guide" },
};

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#121212] flex flex-col">
      <div className="h-12 bg-[#113768] text-white flex items-center px-6 justify-between">
        <div className="flex items-center">
          <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity">
            Stripboard Editor
          </a>
          <span className="opacity-40 mx-3">|</span>
          <span className="opacity-80">Quick Guide</span>
        </div>
        <ThemeToggle />
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 flex-1">
        <h1 className="text-xl sm:text-2xl font-bold text-[#113768] dark:text-[#5b9bd5] mb-6">Quick Guide</h1>

        {/* Workflow */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Workflow</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li><strong>Design the schematic</strong> on the left. Add components from the library and draw wires between pins to define nets.</li>
            <li><strong>Place components on the stripboard</strong> on the right. Drag them from the unplaced tray onto the board.</li>
            <li><strong>Resolve conflicts.</strong> Place cuts between holes to isolate strips and add wires to connect separated nets.</li>
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
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Schematic Editor (left)</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Drag components from the library sidebar onto the canvas.</li>
            <li>Press <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono">W</kbd> to enter wire drawing mode, then click pins to connect them.</li>
            <li>Connected pins automatically form a net. Rename or recolour nets in the sidebar.</li>
            <li>Click a component label to rename it. Click a pin label to rename the pin.</li>
            <li>Drag labels and pin labels to reposition them if they overlap with wires.</li>
            <li>Use the footprint editor (on the stripboard side) to customise a component{"'"}s physical layout.</li>
          </ul>
        </section>

        {/* Stripboard Editor */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Stripboard Editor (right)</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>Drag components from the <em>Unplaced</em> tray onto the board.</li>
            <li>Strips automatically colour to match the net of the pin sitting on them.</li>
            <li>Red highlighted strips indicate a conflict where two different nets share the same strip.</li>
            <li>Click between two holes to place a <strong>cut</strong>, isolating the strip into sections.</li>
            <li>Click a hole then another hole to place a <strong>wire</strong> connecting them. Click an existing wire to delete it.</li>
            <li>2-pin passive components (resistors, LEDs, etc.) have flexible leads. Drag individual pins to reshape them.</li>
            <li>Non-flexible components (ICs, connectors, etc.) can have their footprint edited. Click the <svg className="inline-block mx-0.5" style={{ verticalAlign: "-1px" }} width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="1" y="1" width="10" height="10" rx="1" /><circle cx="3.5" cy="3.5" r="1" fill="currentColor" /><circle cx="8.5" cy="8.5" r="1" fill="currentColor" /></svg> icon next to a component in the sidebar to open the footprint editor. You can resize the grid and move pins around to match your physical component.</li>
            <li>Hover over an incomplete net in the sidebar to highlight the relevant strips.</li>
          </ul>
        </section>

        {/* Keyboard Shortcuts */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Keyboard Shortcuts</h2>
          <div className="space-y-1.5 text-sm">
            {[
              ["R", "Rotate selected component"],
              ["M", "Mirror selected component (schematic)"],
              ["W", "Toggle wire drawing mode (schematic)"],
              ["Delete", "Remove selected component or wire"],
              ["Escape", "Cancel current action or exit wire mode"],
              ["Ctrl + Z", "Undo"],
              ["Ctrl + Y", "Redo"],
              ["Arrow keys", "Move selected components (bulk move)"],
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
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Custom Components</h2>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Click <strong>+ Create Custom</strong> at the bottom of the library.
            Define the grid size, place pins, and assign names. Your custom components are saved with the project
            and appear in a dedicated <em>Custom</em> section.
          </p>
        </section>

        {/* Saving & Sharing */}
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-200 mb-3">Saving &amp; Sharing</h2>
          <ul className="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
            <li>No account is required. When you save a project for the first time, a unique link is generated. Bookmark or save this link to return to your project later.</li>
            <li>You can also export your project as a JSON file and re-import it at any time.</li>
            <li>Creating an account lets you access all your projects from a central dashboard without needing to save individual links.</li>
            <li>Logged-in users can share projects. Each project has an edit link for full access and a separate view-only link for sharing with others.</li>
            <li>Anyone viewing a shared project can <strong>fork</strong> it to create their own editable copy.</li>
          </ul>
        </section>
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-700 mt-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between text-xs text-neutral-400 dark:text-neutral-500">
          <span>
            {"© " + new Date().getFullYear() + " "}
            <a href="https://karl-funke.com?utm_source=stripboard-editor" className="text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] transition-colors">Karl Funke</a>
          </span>
          <a href="/privacy" className="text-neutral-500 dark:text-neutral-400 hover:text-[#113768] dark:hover:text-[#5b9bd5] transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
