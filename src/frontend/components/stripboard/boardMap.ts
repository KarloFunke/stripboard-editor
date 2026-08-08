// ── The board map ──────────────────────────────────────
//
// A board map is a picture of the copper, drawn on a lattice: holes sit on
// the even character columns, and what joins them sits on the odd ones.
//
//     0-0-0   0-0-0     two runs of three, a gap between them
//     |
//     0-0-0   0-0-0     the "|" carries the left column down a row
//
//   HOLE CELLS (even column)
//     0     a hole
//     .     no hole — bare board
//     A-Z   a hole, tagged; the tag labels the copper run it belongs to
//
//   A digit is a hole and a letter is a tag, so the two never collide.
//   "o" and "O" are taken as a plain hole too, since they are the natural
//   thing to type — which is the one reason "O" cannot be a tag.
//
//   LINK CELLS
//     -     copper, joining the holes left and right   (odd column)
//     |     copper, joining the holes above and below  (link row)
//     :     a snap line runs between these two holes; never copper
//     ' '   no copper
//
//   A snap line is a groove scored in the board, not a row of holes, so it
//   lives between two holes rather than taking a pitch of its own.
//
//   LINES
//     A line with no holes on it is a link row: it sits between the hole
//     rows either side of it and takes up no space on the board. "|" joins
//     them with copper; ":" says the board snaps apart there. Blank lines
//     are ignored, so a map can be spaced out for readability, and "#"
//     starts a comment.
//
//   MACROS
//     A block's body is dedented by its own indentation, so nesting a
//     define inside a repeat does not shift the picture sideways.
//
//     define NAME = <one line>      a line you can paste
//     define NAME ... end           a block of lines you can paste
//     {NAME}                        paste it
//     repeat N ... end              repeat the enclosed lines N times
//
//     Blocks paste side by side, joined row by row, so a half is written
//     as "{quarter} : {quarter}" and reads as what it is. Blocks sharing a
//     line must be the same height; a one-line block repeats down it.
//
// Links pointing at a hole that is not there are ignored, so a rail can be
// written as a plain repeat and simply stops where its column runs out.

export interface MapIssue {
  line: number; // 1-based, into the source the user typed
  message: string;
}

export interface ParsedBoardMap {
  rows: number;
  cols: number;
  hole: Uint8Array; // rows*cols
  tag: (string | null)[]; // rows*cols
  hLink: Uint8Array; // rows*(cols-1)
  vLink: Uint8Array; // (rows-1)*cols
  /** Snap lines, on the boundary between two holes (13.5 = between 13 and 14) */
  snapX: number[];
  snapY: number[];
  issues: MapIssue[];
}

const MAX_LINES = 4000;
const MAX_EXPANSION_DEPTH = 12;

interface SourceLine {
  text: string;
  line: number; // 1-based line in the original source
}

// ── Macro expansion ────────────────────────────────────

/** Expand defines, {NAME} pastes and repeat blocks into plain map lines. */
function expand(source: string, issues: MapIssue[]): SourceLine[] {
  const raw = source.split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }));
  const defines = new Map<string, SourceLine[]>();
  const out: SourceLine[] = [];

  // Strip comments but keep column positions: a "#" ends the line.
  const decomment = (s: string) => {
    const i = s.indexOf("#");
    return i < 0 ? s : s.slice(0, i);
  };

  /**
   * Expand the {NAME} references on one line.
   *
   * Blocks stand side by side: "{quarter} : {quarter}" puts two 19-line
   * quarters next to each other, joining them row by row with " : " down
   * the middle, so a line can grow into as many lines as the tallest block
   * on it. Each block's lines are padded to that block's own width first,
   * or the columns to its right would slide about wherever a row happens
   * to be shorter. A one-line block repeats down the whole height, which
   * is what makes a separator or a margin work.
   */
  const REF = /\{\s*([A-Za-z_][\w-]*)\s*\}/g;
  const expandLine = (text: string, line: number): string[] => {
    type Part = { lit: string } | { block: SourceLine[]; width: number };
    const parts: Part[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    REF.lastIndex = 0;
    while ((m = REF.exec(text)) !== null) {
      parts.push({ lit: text.slice(last, m.index) });
      const body = defines.get(m[1]);
      if (!body) {
        issues.push({ line, message: `unknown name {${m[1]}}` });
      } else {
        parts.push({ block: body, width: Math.max(...body.map((b) => b.text.length)) });
      }
      last = m.index + m[0].length;
    }
    if (parts.length === 0) return [text];
    parts.push({ lit: text.slice(last) });

    const blocks = parts.filter((p): p is { block: SourceLine[]; width: number } => "block" in p);
    const tall = blocks.map((b) => b.block.length).filter((h) => h > 1);
    const height = tall.length > 0 ? Math.max(...tall) : 1;
    if (tall.some((h) => h !== height)) {
      issues.push({
        line,
        message: `blocks on one line must be the same height (found ${[...new Set(tall)].sort().join(" and ")} lines)`,
      });
    }

    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      let s = "";
      for (const p of parts) {
        if ("lit" in p) s += p.lit;
        else s += (p.block.length === 1 ? p.block[0].text : p.block[i]?.text ?? "").padEnd(p.width);
      }
      out.push(s.replace(/\s+$/, ""));
    }
    return out;
  };

  const run = (lines: SourceLine[], sink: SourceLine[], depth: number) => {
    if (depth > MAX_EXPANSION_DEPTH) {
      issues.push({ line: lines[0]?.line ?? 1, message: "blocks nested too deeply" });
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const body = decomment(l.text);
      const trimmed = body.trim();
      if (trimmed === "") continue;

      // define NAME = <line>
      const inline = /^define\s+([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(trimmed);
      if (inline) {
        // Keep the body verbatim after the "=", minus one padding space, so
        // leading dots and spaces in the picture survive.
        const eq = body.indexOf("=");
        const text = body.slice(eq + 1).replace(/^ /, "").replace(/\s+$/, "");
        // Expanded now, so every stored block is literal and a name can
        // never refer to itself — it is simply not defined yet.
        defines.set(inline[1], expandLine(text, l.line).map((t) => ({ text: t, line: l.line })));
        continue;
      }

      // define NAME ... end   /   repeat N ... end
      const blockStart = /^(define\s+([A-Za-z_][\w-]*)|repeat\s+(\d+))$/.exec(trimmed);
      if (blockStart) {
        const inner: SourceLine[] = [];
        let level = 1;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const t = decomment(lines[j].text).trim();
          if (/^(define\b|repeat\b)/.test(t)) level++;
          if (t === "end") {
            level--;
            if (level === 0) break;
          }
          inner.push(lines[j]);
        }
        if (j >= lines.length) {
          issues.push({ line: l.line, message: `"${trimmed}" is never closed with "end"` });
          return;
        }
        // Indentation is for reading, not part of the picture: a leading
        // space would otherwise land in the grid as a hole that is not
        // there. Strip what the whole block shares.
        const indent = inner.reduce((m, x) => {
          if (x.text.trim() === "") return m;
          return Math.min(m, x.text.length - x.text.replace(/^ +/, "").length);
        }, Infinity);
        const body2 = Number.isFinite(indent) && indent > 0
          ? inner.map((x) => ({ ...x, text: x.text.slice(indent) }))
          : inner;
        if (blockStart[2]) {
          const collected: SourceLine[] = [];
          run(body2, collected, depth + 1);
          defines.set(blockStart[2], collected);
        } else {
          const times = parseInt(blockStart[3], 10);
          if (times < 0 || times > 1000) {
            issues.push({ line: l.line, message: `repeat ${times} is out of range (0–1000)` });
          } else {
            const once: SourceLine[] = [];
            run(body2, once, depth + 1);
            for (let k = 0; k < times; k++) {
              sink.push(...once);
              // Checked per repetition: nested repeats could otherwise
              // materialise millions of lines before the guard below ran.
              if (sink.length > MAX_LINES) {
                issues.push({ line: l.line, message: `map expanded past ${MAX_LINES} lines` });
                return;
              }
            }
          }
        }
        i = j;
        continue;
      }

      if (trimmed === "end") {
        issues.push({ line: l.line, message: '"end" without a matching define or repeat' });
        continue;
      }

      sink.push(...expandLine(body.replace(/\s+$/, ""), l.line).map((t) => ({ text: t, line: l.line })));
      if (sink.length > MAX_LINES) {
        issues.push({ line: l.line, message: `map expanded past ${MAX_LINES} lines` });
        return;
      }
    }
  };

  run(raw, out, 0);
  return out;
}

// ── Grid parse ─────────────────────────────────────────

type LineKind = "holes" | "links";

/** A line carrying no holes sits between two rows rather than being one. */
function classify(text: string): LineKind {
  return /^[\s|:]*$/.test(text) && /[|:]/.test(text) ? "links" : "holes";
}

export function parseBoardMap(source: string): ParsedBoardMap {
  const issues: MapIssue[] = [];
  const lines = expand(source, issues).filter((l) => l.text.trim() !== "");

  // Pass 1: how big is the grid?
  const holeLines: { text: string; line: number }[] = [];
  let width = 0;
  for (const l of lines) {
    if (classify(l.text) !== "holes") continue;
    holeLines.push(l);
    // Only rows carrying holes set the size: a link row sits between two of
    // them and cannot exist without holes on both sides.
    width = Math.max(width, l.text.replace(/\s+$/, "").length);
  }
  const rows = holeLines.length;
  const cols = Math.floor(width / 2) + 1;
  if (rows === 0 || cols === 0) {
    issues.push({ line: 1, message: "the map has no holes in it" });
    return { rows: 0, cols: 0, hole: new Uint8Array(), tag: [], hLink: new Uint8Array(), vLink: new Uint8Array(), snapX: [], snapY: [], issues };
  }

  const hole = new Uint8Array(rows * cols);
  const tag: (string | null)[] = new Array(rows * cols).fill(null);
  const hLink = new Uint8Array(rows * Math.max(0, cols - 1));
  const vLink = new Uint8Array(Math.max(0, rows - 1) * cols);
  const snapX: number[] = [];
  const snapY: number[] = [];

  // Pass 2: fill it in. Hole rows advance the board row; a link row joins
  // the row above it to the row below; a snap row sits between them.
  let row = -1;
  for (const l of lines) {
    if (classify(l.text) === "links") {
      if (row < 0 || row >= rows - 1) {
        issues.push({ line: l.line, message: "a link row needs a hole row above and below it" });
        continue;
      }
      // Even cells sit under a hole: "|" carries copper down, ":" says the
      // board comes apart between these two rows. The odd cells between
      // them are where a snap line running the other way crosses, which is
      // nothing to record here.
      let snapsHere = false;
      for (let i = 0; i < l.text.length; i += 2) {
        const ch = l.text[i];
        if (ch === "|") {
          if (i / 2 < cols) vLink[row * cols + i / 2] = 1;
        } else if (ch === ":") snapsHere = true;
      }
      if (snapsHere) snapY.push(row + 0.5);
      continue;
    }

    row++;
    for (let i = 0; i < l.text.length; i++) {
      const ch = l.text[i];
      if (ch === " ") continue;
      if (i % 2 === 0) {
        const c = i / 2;
        if (ch === ".") continue;
        if (ch === ":") {
          issues.push({ line: l.line, message: '":" marks a snap line, which goes between two holes, not on one' });
          continue;
        }
        // A digit is a plain hole; "o"/"O" are accepted as the same thing
        // because they are what fingers reach for. Every other letter tags
        // the run its hole belongs to.
        if (/[0-9oO]/.test(ch)) { hole[row * cols + c] = 1; continue; }
        if (/[A-Za-z]/.test(ch)) {
          hole[row * cols + c] = 1;
          tag[row * cols + c] = ch.toUpperCase();
          continue;
        }
        issues.push({ line: l.line, message: `"${ch}" is not a hole — use "0", ".", ":" or a letter` });
      } else {
        const c = (i - 1) / 2;
        if (ch === "-") {
          if (c < cols - 1) hLink[row * (cols - 1) + c] = 1;
        } else if (ch === ":") {
          if (c < cols - 1) snapX.push(c + 0.5);
        } else {
          issues.push({ line: l.line, message: `"${ch}" is not a link — use "-", ":" or a space` });
        }
      }
    }
  }

  // A link that reaches for a hole that is not there simply does not exist:
  // it lets a rail be written as a plain repeat that stops on its own.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (hLink[r * (cols - 1) + c] && !(hole[r * cols + c] && hole[r * cols + c + 1])) {
        hLink[r * (cols - 1) + c] = 0;
      }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (vLink[r * cols + c] && !(hole[r * cols + c] && hole[(r + 1) * cols + c])) {
        vLink[r * cols + c] = 0;
      }
    }
  }

  return {
    rows,
    cols,
    hole,
    tag,
    hLink,
    vLink,
    snapX: Array.from(new Set(snapX)).sort((a, b) => a - b),
    snapY: Array.from(new Set(snapY)).sort((a, b) => a - b),
    issues,
  };
}

// ── Rendering a topology back out as a map ─────────────

/**
 * Write a grid back out as literal map text. Macros are not reconstructed —
 * this is what structural edits (inserting a row, deleting a column) build
 * on, and what "expand" in the editor produces.
 */
export function formatBoardMap(g: {
  rows: number;
  cols: number;
  hole: Uint8Array;
  tag: (string | null)[] | null;
  hLink: Uint8Array;
  vLink: Uint8Array;
  snapX: number[];
  snapY: number[];
}): string {
  const snapAfterCol = new Set(g.snapX.map((x) => Math.floor(x)));
  const snapAfterRow = new Set(g.snapY.map((y) => Math.floor(y)));
  const out: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    let line = "";
    for (let c = 0; c < g.cols; c++) {
      if (c > 0) {
        line += snapAfterCol.has(c - 1) ? ":" : g.hLink[r * (g.cols - 1) + c - 1] ? "-" : " ";
      }
      line += !g.hole[r * g.cols + c] ? "." : g.tag?.[r * g.cols + c] ?? "0";
    }
    out.push(line.replace(/\s+$/, ""));

    if (r >= g.rows - 1) continue;
    // The boundary below this row: a groove the board snaps along, or the
    // copper that carries on down it, or nothing at all.
    if (snapAfterRow.has(r)) {
      out.push(":".repeat(Math.max(1, g.cols * 2 - 1)));
      continue;
    }
    let links = "";
    let any = false;
    for (let c = 0; c < g.cols; c++) {
      if (c > 0) links += " ";
      if (g.vLink[r * g.cols + c]) {
        links += "|";
        any = true;
      } else links += " ";
    }
    if (any) out.push(links.replace(/\s+$/, ""));
  }
  return out.join("\n") + "\n";
}
