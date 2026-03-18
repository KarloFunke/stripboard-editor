import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tutorial",
  description:
    "Step-by-step guide to building a stripboard layout — from adding components to resolving conflicts.",
  alternates: { canonical: "https://stripboard-editor.com/tutorial" },
};

export default function TutorialPage() {
  const steps = [
    {
      image: "/tutorial/01-start-blank-project.png",
      title: "1. Start a new project",
      text: "A blank project with the schematic editor on the left and the stripboard on the right will open. The idea is to design the schematic first on the left, and then place the components on the stripboard on the right. Controls: right-click drag to pan, scroll wheel to zoom, R to rotate a selected component on the stripboard, Delete to remove a component, and Ctrl+Z / Ctrl+Y to undo and redo.",
    },
    {
      image: "/tutorial/02-rename-and-drag-and-drop.png",
      title: "2. Rename and add components",
      text: "Click the project name to rename it. Drag a component from the library onto the schematic canvas. The editor is footprint-centred, meaning we add everything by its footprint and assign things like tags and names later. You can select the tag you want the next component to have prior to adding it, or later by choosing the tag and then clicking on the component's current tag.",
    },
    {
      image: "/tutorial/03-regulator-3-pin.png",
      title: "3. Pick the right footprint",
      text: "Expand different categories to find the footprint you need. Here a 3-pin component is about to be added for a voltage regulator. Tags are applied via the tag bar above.",
    },
    {
      image: "/tutorial/04-all-placed-starting-nets.png",
      title: "4. Place all components, start adding pins to networks",
      text: "All four components are on the schematic. Now it's time to add networks by connecting each pin to a net. There are two default nets in each project, VCC and GND. Click on a net and then on the pins you want to be part of it.",
    },
    {
      image: "/tutorial/05-add-new-net.png",
      title: "5. Add more networks",
      text: "You can add a new network on the bottom left and choose a colour for it. We add a 5 V net for the regulator output.",
    },
    {
      image: "/tutorial/06-auto-net.png",
      title: "6. Use Auto New for quick wiring",
      text: "Select \"Auto New\" in the nets panel. When you click on an unassigned pin, it creates a new net automatically with a random colour. The new net then gets selected and you can assign all other pins belonging to this net.",
    },
    {
      image: "/tutorial/07-schematic-complete.png",
      title: "7. Schematic complete",
      text: "Now we have completed our simple schematic. Time to start editing the stripboard on the right side.",
    },
    {
      image: "/tutorial/08-place-on-stripboard.png",
      title: "8. Drag components to the board",
      text: "Drag components from the \"Unplaced\" tray onto the stripboard. A ghost preview shows where the component will land. After placing it down, each strip shows the colour of the net associated with the touching pin.",
    },
    {
      image: "/tutorial/09-rotate-and-rearrange.png",
      title: "9. Rotate and rearrange",
      text: "All components are placed, but we would like a tighter layout, so we decide to rotate the resistor. Select a component and press R to rotate. Use the arrow keys or drag to reposition.",
    },
    {
      image: "/tutorial/10-resolve-conflicts.png",
      title: "10. Resolve conflicts",
      text: "Rotating the resistor moved its ground pin to a strip that was already on the VCC net. Click between two holes on a strip to place a cut, which isolates the sections.",
    },
    {
      image: "/tutorial/11-finished-layout.png",
      title: "11. Getting finished",
      text: "Green banner: After placing the cut, we need to place a wire to fully connect the ground network. Click on a hole and then another to place a wire in between them. To remove a wire, just click on it. Now the stripboard for the schematic designed on the left is finished!",
    },
    {
      image: "/tutorial/12-edit-component.png",
      title: "12. Edit components",
      text: "Click a component to open its edit popup. Change the label, tag, or pin names. Click outside or press Save to save; X to cancel.",
    },
    {
      image: "/tutorial/13-edit-footprint.png",
      title: "13. Customise footprints",
      text: "Open the footprint editor to modify a component's physical layout. Click cells to toggle between body and pin. This way you can create fully custom footprints.",
    },
    {
      image: "/tutorial/14-component-library.png",
      title: "14. Explore the component library",
      text: "The library offers 2-pin through DIP-20 footprints in various spacings. You can also see our cursed edited custom footprint for the 5 V regulator.",
    },
  ];

  return (
    <div className="min-h-screen bg-[#fafafa] flex flex-col">
      <div className="h-12 bg-[#113768] text-white flex items-center px-6">
        <a href="/" className="font-semibold tracking-wide hover:opacity-80 transition-opacity">
          Stripboard Editor
        </a>
        <span className="opacity-40 mx-3">|</span>
        <span className="opacity-80">Tutorial</span>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-12 flex-1">
        <h1 className="text-2xl font-bold text-[#113768] mb-2">Getting Started</h1>
        <p className="text-neutral-600 mb-10">
          This page shows you how to build a simple circuit containing a connector, voltage regulator, LED, and a resistor.
        </p>

        <div className="space-y-12">
          {steps.map((step, i) => (
            <div key={i}>
              <h2 className="text-lg font-semibold text-neutral-800 mb-2">{step.title}</h2>
              <p className="text-sm text-neutral-600 mb-3">{step.text}</p>
              <img
                src={step.image}
                alt={step.title}
                className="rounded-lg border border-neutral-200 shadow-sm w-full"
              />
            </div>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-neutral-200 text-center">
          <a
            href="/"
            className="inline-block bg-[#113768] text-white px-6 py-3 rounded-lg text-sm font-medium hover:bg-[#0d2a50] transition-colors"
          >
            Start Desigining
          </a>
        </div>
      </div>

      <div className="border-t border-neutral-200 mt-auto">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between text-xs text-neutral-400">
          <span>
            {"© " + new Date().getFullYear() + " "}
            <a href="https://karl-funke.com?utm_source=stripboard-editor" className="text-neutral-500 hover:text-[#113768] transition-colors">Karl Funke</a>
          </span>
          <a href="/privacy" className="text-neutral-500 hover:text-[#113768] transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
