import { Component, ComponentDef } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";

export interface BomRow {
  defName: string;
  value: string; // "" when the component has no value
  qty: number;
  refs: string[];
}

function refSortKey(ref: string): [string, number, string] {
  const m = ref.match(/^(\D*)(\d+)?(.*)$/);
  return [m?.[1] ?? ref, m?.[2] ? parseInt(m[2], 10) : 0, m?.[3] ?? ""];
}

function compareRefs(a: string, b: string): number {
  const ka = refSortKey(a);
  const kb = refSortKey(b);
  return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
}

/** Group every component by definition + value into a parts list. */
export function buildBOM(components: Component[], componentDefs: ComponentDef[]): BomRow[] {
  const groups = new Map<string, BomRow>();
  for (const c of components) {
    const def = resolveComponentDef(c, componentDefs);
    if (!def) continue;
    const value = (def.hasValue ? (c.value ?? "") : "").trim();
    const key = `${def.id} ${value}`;
    let row = groups.get(key);
    if (!row) {
      row = { defName: def.name, value, qty: 0, refs: [] };
      groups.set(key, row);
    }
    row.qty++;
    row.refs.push(c.label);
  }
  const rows = [...groups.values()];
  for (const r of rows) r.refs.sort(compareRefs);
  rows.sort((a, b) => a.defName.localeCompare(b.defName) || a.value.localeCompare(b.value));
  return rows;
}
