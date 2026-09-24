// The changelog data, shared by the /updates page, its markdown twin for
// agents (app/updates.md) and the sitemap's lastModified for that page.
export interface Update {
  date: string;
  items: string[];
  link?: { href: string; lead: string; text: string };
}

export const UPDATES: Update[] = [
  {
    date: "2026-09-24",
    items: [
      "Bug fixed so correctly with the part. The pin 1 notch on an IC and the slider on a switch stayed put at some angles.",
      "The flat side of a TO-92 transistor was drawn on the wrong side of its pins since 2026-09-21 update, so those parts now face the other way. Sorry for that inconvenience.",
    ],
  },
  {
    date: "2026-09-22",
    items: [
      "Your own part library. Keep custom parts in your account and use them in every project, share them as a file, and carry a change into every project that uses the part.",
    ],
  },
  {
    date: "2026-09-21",
    items: [
      "Parts are now drawn as their real packages at true size, and each part lets you pick the package you actually have. The auto layouter and the print use the same bodies.",
      "Off-board parts: mount pots, switches and jacks off the board and get solder pads or a connector for their wires instead.",
      "New wire and cut tools on the board. Cuts can go under parts, ICs bring their own cuts, and wires and cuts can be selected, dragged and deleted.",
    ],
  },
  {
    date: "2026-09-11",
    items: [
      "Schematic editor overhaul. Wires, selection and dragging now work the way they do in other editors, and ground and power flags tie GND or VCC together by name instead of running wires across the sheet.",
    ],
  },
  {
    date: "2026-09-10",
    items: [
      "Releasing Auto Layouter V5. Boards come out smaller, every link wire runs straight along a column and crosses nothing, and connectors end up on a board edge.",
    ],
    link: {
      href: "/how-auto-layout-works",
      lead: "I also wrote up how the whole thing works, with demos you can play with:",
      text: "How auto-layout works.",
    },
  },
  {
    date: "2026-08-21",
    items: [
      "The auto layouter now keeps proper clearance around every part, and can be set to only use drilled cuts instead of cutting the copper between two holes.",
      "Projects can now carry a description and notes.",
    ],
  },
  {
    date: "2026-07-31",
    items: [
      "The auto layouter now produces much straighter wiring: a second solver pass trades a little board space for fewer slanted and crossing wires, and its result is only kept when it actually is tidier. It is on by default and can be turned off in the auto-layout settings. Cuts also line up on shared columns where possible, like a human would place them. Solving is also several times faster than before, especially on big boards.",
      "Board editing: wires can now run in parallel on the same column or row (hold Shift to click through a wire to the holes underneath), and right-clicking a row or column number inserts or deletes a board line.",
    ],
  },
  {
    date: "2026-07-24",
    items: [
      "Big changes to the auto layouter. Many more user settings and it also performs much better overall. That's why I also removed the 'alpha' tag as I think it's quite capable at this point."
    ],
  },
  {
    date: "2026-07-23",
    items: [
      "Netlist export. Export a design to an EDA tool as a KiCad-compatible netlist (.net): components, values, pin numbers and nets all are included, so you can turn a stripboard prototype into a PCB without redesigning the schematic in another tool.",
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
      "New auto-layout router (alpha). Click Auto-layout and the program will try to find a good layout of all components. It works but please consider it the first version I felt comfortable releasing. I plan to further improve on it in the future.",
    ],
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
      "Saving unsaved projects in local storage with the option to restore them when opening a new project again.",
      "Move a whole multi-selection of components at once by dragging it, on both the schematic and the stripboard (previously only possible with the arrow keys).",
    ],
  },
  {
    date: "2026-06-26",
    items: [
      "Copy and paste schematic components with Ctrl+C and Ctrl+V.",
      "The site has moved to dedicated, professional hosting (coming from being hosted on my old PC over my residential ISP) (I got really lucky that this site was up 100% over the last 4 months with this old setup).",
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

export const PLANNED: string[] = [
  "Net list import, the other half of the KiCad compatibility: bring a circuit in from an EDA tool and lay it out on stripboard. Export is already available.",
];
