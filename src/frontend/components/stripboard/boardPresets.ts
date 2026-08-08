import { BoardLayout } from "@/types";
import { mapSize } from "./boardTopology";

// ── Board presets ──────────────────────────────────────
//
// A preset is a stocked board, described the same way a custom board is:
// as a board map. Picking one drops its map in, and everything about it
// stays editable afterwards — a preset is a starting point, not a type.

export interface BoardPreset {
  id: string;
  name: string;
  /** One line for the picker: what the physical board is. */
  summary: string;
  map: string;
}

// ── ElectroCookie snappable PCB ────────────────────────
//
// The board comes apart along two V-cuts into four quarters of 14 x 19
// holes. In a quarter the strips run in threes across the middle twelve
// columns, with a power rail down the outer column on either side; the top
// and bottom rows are grouped differently to clear the mounting holes.
//
// The three sizes are the same map, cut off at a different point: a
// quarter is the unit, a half is two of them across a V-cut, the board is
// two halves across another. A V-cut is a groove scored in the board, so
// it sits on the boundary between two holes and takes no pitch of its own.
// Nothing is written twice, so none of them can drift from the others.
const EC_QUARTER_DEF = `define edge  = . . 0-0 0-0-0 0-0-0 0-0 . .
define inner = . 0-0-0 0-0-0 0-0-0 0-0-0 .
define main  = P 0-0-0 0-0-0 0-0-0 0-0-0 N
define rail  = |                         |

define quarter
  {edge}
  {inner}
  repeat 15
    {main}
    {rail}
  end
  {inner}
  {edge}
end`;

const EC_HALF_DEF = `${EC_QUARTER_DEF}

define half
  {quarter}:{quarter}
end`;

const EC_QUARTER = `# ElectroCookie, one snapped-off quarter.
# P and N are its two power rails.

${EC_QUARTER_DEF}

{quarter}
`;

const EC_HALF = `# ElectroCookie, half the board: two quarters across the V-cut
# they come apart on.

${EC_HALF_DEF}

{half}
`;

const EC_FULL = `# ElectroCookie snappable PCB, the whole board: two halves across
# another V-cut. ":" marks every line it snaps along.

${EC_HALF_DEF}

{half}
::::::
{half}
`;

/** A veroboard: every row one strip running the full width. */
function veroboard(rows: number, cols: number): string {
  const row = Array.from({ length: cols }, () => "0").join("-");
  return `# Plain stripboard — ${cols} columns of continuous copper, ${rows} rows.\n` +
    `define row = ${row}\n\nrepeat ${rows}\n  {row}\nend\n`;
}

/** A veroboard with a power rail down each outer column. */
function edgeRails(rows: number, cols: number): string {
  const middle = Array.from({ length: cols - 2 }, () => "0").join("-");
  return `# Stripboard with a power rail down each outer column.\n` +
    `define row  = P ${middle} N\n` +
    `define rail = |${" ".repeat((cols - 2) * 2 + 1)}|\n\n` +
    `repeat ${rows}\n  {row}\n  {rail}\nend\n`;
}

export const BOARD_PRESETS: BoardPreset[] = [
  {
    id: "plain",
    name: "Stripboard (Veroboard)",
    summary: "Every row is one uninterrupted copper strip — the classic board.",
    map: veroboard(20, 20),
  },
  {
    id: "rails-both-edges",
    name: "Stripboard with edge power rails",
    summary: "Classic strips with a + and a − bus running down the outer columns.",
    map: edgeRails(24, 24),
  },
  {
    id: "electrocookie-quarter",
    name: "ElectroCookie — quarter",
    summary: "One snapped-off quarter: strips in threes, a power rail down each side.",
    map: EC_QUARTER,
  },
  {
    id: "electrocookie-half",
    name: "ElectroCookie — half",
    summary: "Two quarters, as the board comes apart along one of its V-cuts.",
    map: EC_HALF,
  },
  {
    id: "electrocookie-snappable",
    name: "ElectroCookie — whole board",
    summary: "All four quarters, with both V-cut lines the board snaps along.",
    map: EC_FULL,
  },
];

export function findPreset(id: string | undefined): BoardPreset | undefined {
  return id ? BOARD_PRESETS.find((p) => p.id === id) : undefined;
}

/**
 * The layout a preset produces, plus the board size its map implies. Sizes
 * are resolved once here rather than per render: the maps are constants.
 */
const sizes = new Map(BOARD_PRESETS.map((p) => [p.id, mapSize(p.map) ?? { rows: 20, cols: 20 }]));

export function presetSize(preset: BoardPreset): { rows: number; cols: number } {
  return sizes.get(preset.id)!;
}

export function presetBoard(preset: BoardPreset): { layout: BoardLayout; rows: number; cols: number } {
  return { layout: { map: preset.map }, ...presetSize(preset) };
}
