// Custom parts: made in the editor, kept in one project or in the user's
// library. A project never points at the library; it holds a copy, linked by
// `library: { id, rev }` until that copy is edited on its own.
import type { ComponentDef } from "@/types";
import type { LibraryPart } from "@/lib/api";
import { createFootprintSymbol, registerCustomSymbol } from "./symbolDefs";

const FOOTPRINT_PREFIX = "custom-footprint-";

/** A part drawn from its own footprint (the grid editor) needs its symbol made before it can render. */
export function registerPartSymbol(def: ComponentDef) {
  if (!def.symbol.startsWith(FOOTPRINT_PREFIX)) return;
  registerCustomSymbol(def.symbol.slice(FOOTPRINT_PREFIX.length), {
    ...createFootprintSymbol(def.pins, def.width, def.height),
    symbolId: def.symbol,
  });
}

/** The same part under another id; a grid part's symbol is named after its id. */
export function withPartId(def: ComponentDef, id: string): ComponentDef {
  const symbol = def.symbol.startsWith(FOOTPRINT_PREFIX) ? `${FOOTPRINT_PREFIX}${id}` : def.symbol;
  return { ...def, id, symbol };
}

export function newCustomId(): string {
  return `custom-${crypto.randomUUID()}`;
}

/** A library part as the panel shows it, before it is copied into a project. */
export function libraryDef(lp: LibraryPart): ComponentDef {
  const def = { ...withPartId(lp.part, `library-${lp.id}`), library: { id: lp.id, rev: lp.rev } };
  registerPartSymbol(def);
  return def;
}

/** What a library part stores: the part without its project id or link. */
export function libraryPayload(def: ComponentDef): ComponentDef {
  const rest = { ...def };
  delete rest.library;
  return withPartId(rest, "library-part");
}

/** Whether the part now sits differently on the board, so placed copies no longer fit. */
export function footprintChanged(a: ComponentDef, b: ComponentDef): boolean {
  // Pin names are only labels; where the legs go is what counts
  const legs = (d: ComponentDef) => JSON.stringify(d.pins.map((p) => [p.id, p.offsetRow, p.offsetCol]));
  return (
    a.width !== b.width ||
    a.height !== b.height ||
    legs(a) !== legs(b) ||
    JSON.stringify(a.bodyCells ?? null) !== JSON.stringify(b.bodyCells ?? null)
  );
}

// Parts files: a whole library or a single part, to keep or to give to someone
export const PARTS_FILE_FORMAT = "stripboard-editor-parts";

export function partsFile(parts: ComponentDef[]): string {
  return JSON.stringify({ format: PARTS_FILE_FORMAT, version: 1, parts: parts.map(libraryPayload) }, null, 2);
}

export function readPartsFile(text: string): ComponentDef[] {
  let data: { format?: unknown; parts?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON");
  }
  if (data?.format !== PARTS_FILE_FORMAT || !Array.isArray(data.parts)) {
    throw new Error("This is not a parts file from the Stripboard Editor");
  }
  return data.parts as ComponentDef[];
}
