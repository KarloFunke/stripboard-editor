"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ComponentDef, NetLabel, NetLabelKind } from "@/types";
import { snapToGrid } from "@/utils/schematicConstants";
import { COMPONENT_GROUPS, DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { getSymbolDef } from "@/data/symbolDefs";
import { getSymbolBounds } from "./SymbolRenderer";
import CustomComponentEditor from "./CustomComponentEditor";

// Fixed thumbnail box so every tray tile is the same size regardless of the
// symbol's own dimensions.
const THUMB_BOX = 56;

function SymbolThumbnail({ def }: { def: ComponentDef }) {
  const symbolDef = getSymbolDef(def.symbol);
  if (!symbolDef) return null;

  const bounds = getSymbolBounds(def.symbol, 0);
  const pad = 5;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  // Shrink large symbols to fit the box, but never enlarge small ones past the
  // base scale, so a tiny capacitor and a big IC stay visually comparable.
  const fit = (THUMB_BOX - pad * 2) / Math.max(bounds.width, bounds.height, 1);
  const scale = Math.min(0.4, fit);

  return (
    <svg width={THUMB_BOX} height={THUMB_BOX} className="flex-shrink-0">
      <g transform={`translate(${THUMB_BOX / 2}, ${THUMB_BOX / 2}) scale(${scale}) translate(${-cx}, ${-cy})`}>
        {symbolDef.bodyPaths.map((path, i) => (
          <path
            key={`b-${i}`}
            d={path.d}
            fill={path.fill === "currentColor" ? "var(--symbol-stroke)" : (path.fill ?? "none")}
            stroke={path.stroke ?? "var(--symbol-stroke)"}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {symbolDef.pins.map((pin) => (
          <circle
            key={pin.pinId}
            cx={pin.stubEnd.x}
            cy={pin.stubEnd.y}
            r={2.5}
            fill="var(--hole-fill)"
            stroke="var(--pin-text)"
            strokeWidth={1}
          />
        ))}
        {symbolDef.extraElements?.map((el, i) => {
          if (el.type === "line") {
            return (
              <line
                key={`e-${i}`}
                x1={el.props.x1 as number} y1={el.props.y1 as number}
                x2={el.props.x2 as number} y2={el.props.y2 as number}
                stroke="var(--symbol-stroke)" strokeWidth={1} strokeLinecap="round"
              />
            );
          }
          if (el.type === "circle") {
            return (
              <circle
                key={`e-${i}`}
                cx={el.props.cx as number} cy={el.props.cy as number}
                r={el.props.r as number}
                fill="none" stroke="var(--symbol-stroke)" strokeWidth={1}
              />
            );
          }
          return null;
        })}
      </g>
    </svg>
  );
}

/** What the part physically is, for the row under its name */
function packageLabel(def: ComponentDef): string {
  const f = def.footprint;
  if (f?.kind === "dip") return `DIP-${f.pins}`;
  if (f?.kind === "to") return "TO-92 / TO-220";
  if (f?.kind === "breakout") return `Module, ${f.left.length + f.right.length} pins`;
  return `${new Set(def.pins.map((p) => p.id)).size} pins`;
}

const squash = (text: string) => text.toLowerCase().replace(/[\s\-_]/g, "");

/** Whether every word appears in the part's name, description or aliases */
function matchesWords(def: ComponentDef, words: string[]): boolean {
  const text = [def.name, def.description ?? "", ...(def.aliases ?? [])].join(" ").toLowerCase();
  return words.every((w) => text.includes(w) || squash(text).includes(w));
}

/**
 * Parts matching the query, names that start with it first. Spaces and dashes
 * do not count, so "op amp" finds "opamp" and "tl 072" finds "TL072".
 */
function searchParts(defs: ComponentDef[], query: string): ComponentDef[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const whole = squash(query);
  const rank = (d: ComponentDef) => (squash(d.name).startsWith(whole) ? 0 : squash(d.name).includes(whole) ? 1 : 2);
  return defs
    .filter((d) => matchesWords(d, words) || matchesWords(d, [whole]))
    .map((d, i) => ({ d, i, r: rank(d) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.d);
}

function PartRow({ def, onAdd, onDragStart }: { def: ComponentDef; onAdd: () => void; onDragStart: (e: React.DragEvent) => void }) {
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onClick={onAdd}
      className="w-full text-left px-2 py-1 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
      title={def.description ? `${def.name}: ${def.description}` : def.name}
    >
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate">{def.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">{packageLabel(def)}</span>
      </span>
      {def.description && (
        <span className="block text-xs text-neutral-500 dark:text-neutral-400 truncate">{def.description}</span>
      )}
    </button>
  );
}

const FLAGS_GROUP = "Power & labels";
function FlagGlyph({ kind, name }: { kind: NetLabelKind; name: string }) {
  const showName = kind !== "gnd" || name !== "GND";
  const text = showName ? (
    <text y={kind === "gnd" ? 16 : kind === "power" ? -4 : -6} fontSize={9} textAnchor="middle" fontWeight={600} fill="var(--symbol-stroke)" stroke="none">
      {name.length > 7 ? name.slice(0, 6) + "…" : name}
    </text>
  ) : null;
  if (kind === "gnd") {
    return <><line x1={0} y1={-10} x2={0} y2={0} /><line x1={-8} y1={0} x2={8} y2={0} /><line x1={-5} y1={4} x2={5} y2={4} /><line x1={-2} y1={8} x2={2} y2={8} />{text}</>;
  }
  if (kind === "power") {
    return <><line x1={0} y1={10} x2={0} y2={0} /><line x1={-7} y1={0} x2={7} y2={0} />{text}</>;
  }
  return <><line x1={0} y1={10} x2={0} y2={2} /><path d="M -4 2 L 4 2 L 4 -2 L -4 -2 Z" />{text}</>;
}

/** The three stock flags plus one tile per distinct flag name used in the project */
function flagTiles(netLabels: NetLabel[]): { kind: NetLabelKind; name: string; stock: boolean }[] {
  const tiles: { kind: NetLabelKind; name: string; stock: boolean }[] = [
    { kind: "gnd", name: "GND", stock: true },
    { kind: "power", name: "VCC", stock: true },
    { kind: "label", name: "NET", stock: true },
  ];
  const seen = new Set(tiles.map((t) => `${t.kind}:${t.name}`));
  for (const l of netLabels) {
    const k = `${l.kind}:${l.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    tiles.push({ kind: l.kind, name: l.name, stock: false });
  }
  return tiles;
}

export default function ComponentLibrary() {
  const addComponent = useProjectStore((s) => s.addComponent);
  const addNetLabel = useProjectStore((s) => s.addNetLabel);
  const netLabels = useProjectStore((s) => s.netLabels);
  const addComponentDef = useProjectStore((s) => s.addComponentDef);
  const removeComponentDef = useProjectStore((s) => s.removeComponentDef);
  const componentDefs = useProjectStore((s) => s.componentDefs);

  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [query, setQuery] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<ComponentDef | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    new Set([FLAGS_GROUP, COMPONENT_GROUPS[0].label])
  );

  // Custom components = defs not in DEFAULT_COMPONENTS
  const defaultIds = new Set(DEFAULT_COMPONENTS.map((d) => d.id));
  const customDefs = componentDefs.filter((d) => !defaultIds.has(d.id));

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const handleAdd = (defId: string) => {
    addComponent(defId, { x: snapToGrid(100 + Math.random() * 200), y: snapToGrid(100 + Math.random() * 200) });
  };

  const handleDragStart = (e: React.DragEvent, defId: string) => {
    e.dataTransfer.setData("application/schematic-component", defId);
    e.dataTransfer.effectAllowed = "copy";
  };

  const results = searchParts([...COMPONENT_GROUPS.flatMap((g) => g.components), ...customDefs], query);
  const searching = query.trim() !== "";

  const handleCreateCustom = (def: ComponentDef) => {
    addComponentDef(def);
    setShowCustomEditor(false);
  };

  return (
    <div className="font-sans flex flex-col flex-1 min-h-0 border-b border-neutral-200 dark:border-neutral-700">
      <div className="px-3.5 py-2.5 font-mono text-xs font-semibold text-[var(--copper)] uppercase tracking-[0.15em]">
        Components
      </div>
      <div className="relative px-2.5 pb-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search parts, e.g. TL072"
          aria-label="Search parts"
          className="w-full px-2.5 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:border-[var(--copper)]"
        />
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {searching && (
          <div className="px-2.5 pb-2.5">
            {results.length === 0 ? (
              <p className="px-1 py-2 text-sm text-neutral-500 dark:text-neutral-400">No part matches &ldquo;{query.trim()}&rdquo;.</p>
            ) : (
              results.map((def) => (
                <PartRow key={def.id} def={def} onAdd={() => handleAdd(def.id)} onDragStart={(e) => handleDragStart(e, def.id)} />
              ))
            )}
          </div>
        )}
        {/* Ground, power and net labels: one connection point, joined by name.
            Every flag name used in the project gets its own tile. */}
        {!searching && (() => {
          const tiles = flagTiles(netLabels);
          const isOpen = openGroups.has(FLAGS_GROUP);
          return (
            <div>
              <button
                onClick={() => toggleGroup(FLAGS_GROUP)}
                className="w-full flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                <span className="text-xs">{isOpen ? "▼" : "▶"}</span>
                {FLAGS_GROUP}
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto text-xs">{tiles.length}</span>
              </button>
              {isOpen && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5 px-2.5 pb-2.5">
                  {tiles.map((t) => (
                    <button
                      key={`${t.kind}:${t.name}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/schematic-netlabel", JSON.stringify({ kind: t.kind, name: t.name }));
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => addNetLabel(t.kind, { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 }, t.name)}
                      className="w-full flex flex-col items-center gap-1 px-1 py-1.5 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
                      title={
                        t.kind === "gnd" ? `Ground flag ${t.name}: every ${t.name} flag is one net`
                        : t.kind === "power" ? `Power flag ${t.name}: flags with the same name are one net`
                        : `Net label ${t.name}: same name, same net`
                      }
                    >
                      <svg width={36} height={36} viewBox="-18 -18 36 36" className="flex-shrink-0" stroke="var(--symbol-stroke)" strokeWidth={1.5} strokeLinecap="round" fill="none">
                        <FlagGlyph kind={t.kind} name={t.name} />
                      </svg>
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight text-center max-w-full truncate">
                        {t.stock ? (t.kind === "gnd" ? "GND" : t.kind === "power" ? "Power" : "Net label") : t.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {!searching && COMPONENT_GROUPS.map((group) => {
          const isOpen = openGroups.has(group.label);
          return (
            <div key={group.label}>
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                <span className="text-xs">{isOpen ? "▼" : "▶"}</span>
                {group.label}
                <span className="text-neutral-400 dark:text-neutral-500 ml-auto text-xs">{group.components.length}</span>
              </button>
              {isOpen && group.rows && (
                <div className="px-2.5 pb-2.5">
                  {group.components.map((def) => (
                    <PartRow key={def.id} def={def} onAdd={() => handleAdd(def.id)} onDragStart={(e) => handleDragStart(e, def.id)} />
                  ))}
                </div>
              )}
              {isOpen && !group.rows && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-1.5 px-2.5 pb-2.5">
                  {group.components.map((def) => (
                    <button
                      key={def.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, def.id)}
                      onClick={() => handleAdd(def.id)}
                      className="w-full flex flex-col items-center gap-1 px-1 py-1.5 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
                      title={def.name}
                    >
                      <SymbolThumbnail def={def} />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight text-center max-w-full">
                        {def.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Custom components section */}
        {!searching && customDefs.length > 0 && (
          <div>
            <button
              onClick={() => toggleGroup("Custom")}
              className="w-full flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
            >
              <span className="text-xs">{openGroups.has("Custom") ? "▼" : "▶"}</span>
              Custom
              <span className="text-neutral-400 dark:text-neutral-500 ml-auto text-xs">{customDefs.length}</span>
            </button>
            {openGroups.has("Custom") && (
              <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5">
                {customDefs.map((def) => (
                  <div key={def.id} className="relative group">
                    <button
                      draggable
                      onDragStart={(e) => handleDragStart(e, def.id)}
                      onClick={() => handleAdd(def.id)}
                      className="w-full flex flex-col items-center gap-1 px-1 py-1.5 rounded border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800 active:bg-neutral-100 dark:active:bg-neutral-700 transition-colors cursor-grab active:cursor-grabbing"
                      title={def.name}
                    >
                      <SymbolThumbnail def={def} />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight text-center max-w-full">
                        {def.name}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm(def);
                      }}
                      className="absolute -top-1 -right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-red-400 text-white text-[9px] leading-none"
                      title="Remove custom component"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="px-3.5 py-2 border-t border-neutral-200 dark:border-neutral-700 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
        IC pinouts from the{" "}
        <a
          href="https://gitlab.com/kicad/libraries/kicad-symbols"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          KiCad symbol library
        </a>
        , licensed{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          CC-BY-SA 4.0
        </a>
        .
      </p>

      {/* Create custom button */}
      <div className="px-2.5 py-2 border-t border-neutral-200 dark:border-neutral-700">
        <button
          onClick={() => setShowCustomEditor(true)}
          className="w-full font-mono text-xs py-1.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          + Create Custom Component
        </button>
      </div>

      {showCustomEditor && (
        <CustomComponentEditor
          onSave={handleCreateCustom}
          onClose={() => setShowCustomEditor(false)}
        />
      )}

      {/* Delete custom component confirmation */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 w-[calc(100%-2rem)] sm:w-80 max-w-sm mx-4 sm:mx-0"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">Delete Custom Component</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
              Are you sure you want to delete{" "}
              <span className="font-medium">{deleteConfirm.name}</span>
              ? Any placed components using it will be removed too.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  removeComponentDef(deleteConfirm.id);
                  setDeleteConfirm(null);
                }}
                className="px-4 py-2 text-sm rounded bg-red-500 dark:bg-red-600 text-white font-medium hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
