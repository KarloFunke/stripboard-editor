import { Component, ComponentDef } from "@/types";
import { spanLimits, FootprintRect } from "../flexGeometry";

// ── Shared data model of the tile pipeline (stage 1) ───
// analyzeCluster/planTile (tilePlanning.ts) produce these shapes,
// packTile/flipTile (tilePacking.ts) consume them, and the stage-2
// composers (composeTiles.ts, floorplan2D.ts) arrange the finished tiles.

export type Rot = 0 | 90 | 180 | 270;
export type Side = "L" | "R" | "F";

export interface Flex {
  comp: Component;
  def: ComponentDef;
  netA: string;
  netB: string;
}

export interface RigidRotation {
  rot: Rot;
  box: FootprintRect; // local bounds (pins + body) at this rotation
  pinned: Map<string, { row: number; side: Side }>; // net -> first local pin row
  pinClaims: { net: string; row: number; col: number }[]; // every assigned pin hole
  clean: boolean; // every assigned pin can reach open board along its row
}

export interface RigidCand {
  comp: Component;
  def: ComponentDef;
  rotations: RigidRotation[];
  fixed?: { row: number; col: number }; // locked: this board position is frozen
}

export interface ClusterAnalysis {
  netOf: Map<string, string>;
  rigids: RigidCand[]; // multi-pin rigids, chain-ordered by shared nets
  groupOf: Map<string, number>; // comp id -> index of the rigid it belongs with
  taps: { comp: Component; def: ComponentDef }[];
  flexes: Flex[];
  // flexes with exactly one connected pin: that pin sits on its net's row,
  // the other end just parks on a free row nearby
  flexTaps: { comp: Component; def: ComponentDef; net: string; firstAssigned: boolean }[];
  skipped: Component[];
}

/** dr -> smallest column offset that makes the span legal */
const drowsCache = new WeakMap<ComponentDef, Map<number, number>>();

export function allowedDrows(def: ComponentDef): Map<number, number> {
  const cached = drowsCache.get(def);
  if (cached) return cached;
  const { min, max } = spanLimits(def);
  const D = new Map<number, number>();
  // dr = 0 lays the part along one row; when its nets differ the router
  // severs the copper between the pins (an inner-cluster cut)
  const dc0 = Math.max(1, Math.ceil(min - 1e-6));
  if (dc0 <= max + 1e-6) D.set(0, dc0);
  for (let dr = 1; dr <= Math.floor(max); dr++) {
    for (let dc = 0; dc <= 3; dc++) {
      const d = Math.hypot(dr, dc);
      if (d >= min - 1e-6 && d <= max + 1e-6) {
        D.set(dr, dc);
        break;
      }
    }
  }
  drowsCache.set(def, D);
  return D;
}

export interface TilePart {
  comp: Component;
  row1: number;
  col1: number;
  row2?: number;
  col2?: number;
}

export interface Tile {
  height: number;
  width: number;
  parts: TilePart[];
  rigidParts: { comp: Component; row: number; col: number; rotation: Rot }[];
  rowsOfNet: Map<string, Set<number>>;
  unplaced: Component[];
  dropWires: number; // parts that needed a fresh row of their own (one wire each)
  anchor?: { row: number; col: number }; // board position of local (0,0): tile holds locked parts
  flipped?: Tile; // the same block rotated 180° — often aligns better with neighbors
}

/** Nets two finished tiles have in common (composition affinity). */
export function sharedNetCount(a: Tile, b: Tile): number {
  let n = 0;
  for (const net of a.rowsOfNet.keys()) if (b.rowsOfNet.has(net)) n++;
  return n;
}

// A net pinned by several rigids splits into one key per copper-joinable run
// (same row, compatible sides, nothing pinned in between): keys are what get
// strip rows. `regions` are the column intervals a key's segment can reach
// (region i = the gap left of rigid i; region k = right of the last rigid),
// and [rankLo, rankHi] is the key's segment interval along its row — claims
// of keys with disjoint intervals must keep left-to-right order or no cut
// can separate them.
export interface KeyInfo {
  row: number;
  regions: Set<number>;
  rankLo: number;
  rankHi: number;
  entries: { gi: number; side: Side }[]; // which rigids pin this key, and how
}

export interface ConfigKeys {
  keyInfo: Map<string, KeyInfo>;
  keyOfEntry: Map<string, string>; // `${rigidIdx}:${netId}` -> key
  altReal: Map<string, string>;
  wiresPinned: number; // joins the copper can't make: one wire each
  pinRows: Set<number>;
  minR: number;
  maxR: number;
}

export interface TilePlan {
  rotSel: RigidRotation[];
  offsets: number[];
  keyInfo: Map<string, KeyInfo>;
  keyOfEntry: Map<string, string>;
  altReal: Map<string, string>; // any non-base key -> its real net
  flexEff: Map<string, { a: string; b: string }>;
  tapKey: Map<string, string>;
  assignment: Map<string, number>;
  violated: Set<string>; // flex comp ids whose span constraint had to give
  wires: number;
  area: number;
  height: number;
  span: number;
}

export const MAX_TILE_RIGIDS = 16;


// Locked board dimensions (the user's physical stripboard) as hard limits
export interface DimLimits {
  maxRows?: number;
  maxCols?: number;
}
