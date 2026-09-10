import { pinKey } from "./keys";
import { Board, Component, ComponentDef, Net, NetAssignment } from "@/types";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { getComponentBounds, getRotatedPinPositions } from "./boardLayout";
import { deriveCompletion } from "./autoFinish";
import { computeStripSegments } from "./stripSegments";
import { computeConnectivity } from "./connectivity";
import { checkNetCompleteness } from "./netCompleteness";
import { FootprintRect, clearanceOf, rectsOverlap } from "./flexGeometry";
import { allowedDrows } from "./layout2/tileModel";
import { AREA_WEIGHT } from "./layout2/tidyScore";
import { Chooser } from "./layout2/chooser";
import { compactPlacements } from "./layout2/compaction";
import { insertWireChannels } from "./layout2/channelPass";
import { repairSlantWires } from "./layout2/slantRepairPass";
import { AutoLayoutProgress, AutoLayoutResult, LayoutPlacement } from "./layoutTypes";

// ── The v3 "annealed slot-band" layouter (experimental) ────────────────
//
// A flat simulated-annealing solver over a stripboard-native genotype, built
// on the observation that ANY overlap-free grid placement is electrically
// realizable: cuts are forced by placement and link wires are derivable, so
// validity reduces to geometric non-overlap and the completion router
// (deriveCompletion) doubles as an exact evaluator.
//
//   genotype  an ordered list of row bands; each band an ordered list of
//             SLOTS, and each slot a vertical stack of parts with a vertical
//             offset (pad). Parts carry orientation genes (rotation for
//             rigids, span/flip for flexible 2-pin parts); slots carry local
//             space genes (extra free columns before the slot, pad rows
//             above the stack), bands carry extra free rows — the
//             part-anchored form of channel columns and bus rows. The
//             two-level structure lets short parts stack beside tall ones
//             (no wasted rows under min-span parts) and can represent the
//             v2 pipeline's nested 2D compositions, which one-level bands
//             could not.
//   decoder   total: left-packs slots per band with pairwise clearance
//             gaps, stacks parts inside slots, stacks the bands; every
//             genotype decodes to a legal board
//   cost      the v2 chooser's own economics (area + wire mess + wire length
//             + aspect + slants), with unroutable nets as a finite penalty
//   search    classical Metropolis annealing, seeded and deterministic;
//             cold start from a connectivity-ordered square-ish packing;
//             directed moves (net-gather, pin/pad-snap, starvation repair)
//             attack strip sharing and routing starvation head-on
//   finisher  the v2 pipeline's own post-ladder passes (compaction harvest,
//             wire channels, slant repair), so finished boards are
//             comparable with v2 results
//
// Locked parts stay exactly where they are: they are not genes but priced
// obstacles — the decoder's coordinates are absolute board coordinates, so
// a moving part that decodes onto a locked footprint (clearance included)
// pays a penalty, and the directed repair move shoves or relocates the
// offender. Locked board dimensions become the cold start's target width
// and an over-cap penalty (the locked area itself is pre-paid, as in v2).
//
// v0 limitations (benchmark harness scope): drilled-cuts-only is not offered.

export interface AutoLayout3Options {
  // Seed for the deterministic annealing run (portfolio = several seeds)
  seed?: number;
  // Annealing move budget (default scales with part count)
  moves?: number;
  // Run the shared v2 finisher passes on the final board (default true)
  finisher?: boolean;
  // Extra annealing-only cost per link wire (search shaping: pushes same-net
  // pins onto shared strips; the reported rating never includes it)
  wireCost?: number;
  // Warm start: anneal from this layout's placements instead of a cold
  // start. The encoding is a band/slot readout: vertically separable runs
  // become bands, column-overlapping parts stack into slots, pads keep the
  // vertical registration. Runs a cooler schedule so the anneal polishes
  // the inherited structure instead of melting it.
  warmStart?: LayoutPlacement[];
  // Harness-only observation hook: per-iteration statistics
  onStat?: (s: { iter: number; T: number; cost: number; best: number; accepted: boolean }) => void;
}

type Rot = 0 | 90 | 180 | 270;
const ROTS: Rot[] = [0, 90, 180, 270];
const MAX_GAP = 3; // free columns before a slot
const MAX_PAD = 8; // free rows above a slot's stack, inside its band

interface RigidShape {
  w: number;
  h: number;
  dRow: number; // bbox min offset of the def at this rotation: anchor = bboxPos - d
  dCol: number;
}

interface PartInfo {
  comp: Component;
  def: ComponentDef;
  flexible: boolean;
  clr: number;
  shapes: Map<Rot, RigidShape>; // rigid only
  drs: { dr: number; dc: number }[]; // flexible only: legal (rowspan, colspan) pairs
}

interface Gene {
  pi: PartInfo;
  rot: Rot; // rigid only
  drIdx: number; // flexible only
  flip: boolean; // flexible only: which pin is the top/left one
}

interface Slot {
  gap: number; // extra free columns before this slot (anchored channel)
  pad: number; // free rows between the band top and this slot's stack
  genes: Gene[]; // vertical stack, top to bottom
}

interface Band {
  gapAbove: number; // extra free rows above this band (anchored bus row, 0..2)
  slots: Slot[];
}

type Genome = Band[];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dimsOf(g: Gene): { w: number; h: number } {
  if (g.pi.flexible) {
    const d = g.pi.drs[g.drIdx];
    return { w: d.dc + 1, h: d.dr + 1 };
  }
  const s = g.pi.shapes.get(g.rot)!;
  return { w: s.w, h: s.h };
}

// Row offset of each gene within its slot's stack (clearance gaps between
// stacked bodies use the shared-moat rule), plus the stack's total height.
function stackOffsets(slot: Slot): { offs: number[]; h: number } {
  const offs: number[] = [];
  let off = 0;
  let prevClr = -1;
  for (const g of slot.genes) {
    if (prevClr >= 0) off += Math.max(prevClr, g.pi.clr);
    offs.push(off);
    off += dimsOf(g).h;
    prevClr = g.pi.clr;
  }
  return { offs, h: Math.max(off, 1) };
}

function slotClr(slot: Slot): number {
  let c = 0;
  for (const g of slot.genes) if (g.pi.clr > c) c = g.pi.clr;
  return c;
}

function slotWidth(slot: Slot): number {
  let w = 1;
  for (const g of slot.genes) {
    const d = dimsOf(g);
    if (d.w > w) w = d.w;
  }
  return w;
}

interface GeneRect {
  bi: number;
  si: number;
  gi: number;
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
}

// Left-pack each band's slots, stack parts inside slots, stack the bands.
// Gaps between neighbouring bodies are the larger of the two parts'
// clearances (the shared-moat rule), which the real geometry checks
// (bodiesTooClose / bodyIntersectsRect) accept; slot- and band-level maxima
// are used conservatively. One margin column on each side gives edge
// segments a wire flank, as the v2 pipeline does.
function decode(
  genome: Genome,
  base: Component[]
): { virtual: Component[]; rows: number; cols: number; rects: GeneRect[] } {
  const placed = new Map<string, Component>();
  const rects: GeneRect[] = [];
  let rowCur = 0;
  let maxEnd = 0;
  let prevBandClr = -1;
  for (let bi = 0; bi < genome.length; bi++) {
    const band = genome[bi];
    if (band.slots.every((s) => s.genes.length === 0)) continue;
    let bandClr = 0;
    let bandH = 1;
    for (const slot of band.slots) {
      if (slot.genes.length === 0) continue;
      const c = slotClr(slot);
      if (c > bandClr) bandClr = c;
      const { h } = stackOffsets(slot);
      if (slot.pad + h > bandH) bandH = slot.pad + h;
    }
    if (prevBandClr >= 0) rowCur += Math.max(prevBandClr, bandClr);
    rowCur += band.gapAbove;
    let x = 1;
    let prevClr = -1;
    for (let si = 0; si < band.slots.length; si++) {
      const slot = band.slots[si];
      if (slot.genes.length === 0) continue;
      const sc = slotClr(slot);
      const sw = slotWidth(slot);
      if (prevClr >= 0) x += Math.max(prevClr, sc);
      x += slot.gap;
      const { offs } = stackOffsets(slot);
      for (let gi = 0; gi < slot.genes.length; gi++) {
        const g = slot.genes[gi];
        const { w, h } = dimsOf(g);
        const top = rowCur + slot.pad + offs[gi];
        rects.push({ bi, si, gi, minRow: top, minCol: x, maxRow: top + h - 1, maxCol: x + w - 1 });
        if (g.pi.flexible) {
          const d = g.pi.drs[g.drIdx];
          const p1 = { row: top, col: x };
          const p2 = { row: top + d.dr, col: x + d.dc };
          placed.set(g.pi.comp.id, {
            ...g.pi.comp,
            boardPos: g.flip ? p2 : p1,
            rotation: 0,
            flexibleEndPos: g.flip ? p1 : p2,
          });
        } else {
          const s = g.pi.shapes.get(g.rot)!;
          placed.set(g.pi.comp.id, {
            ...g.pi.comp,
            boardPos: { row: top - s.dRow, col: x - s.dCol },
            rotation: g.rot,
            flexibleEndPos: undefined,
          });
        }
      }
      x += sw;
      prevClr = sc;
    }
    if (x > maxEnd) maxEnd = x;
    rowCur += bandH;
    prevBandClr = bandClr;
  }
  const rows = Math.max(rowCur, 2);
  const cols = Math.max(maxEnd + 1, 3);
  const virtual = base.map((c) => placed.get(c.id) ?? c);
  return { virtual, rows, cols, rects };
}

interface Evaled {
  cost: number;
  bad: number;
  rows: number;
  cols: number;
  // Starvation feedback for the directed repair move
  starved: { row: number; col: number }[];
  rects: GeneRect[];
  // Genes decoded onto a locked footprint (directed repair targets)
  lockHits: { bi: number; si: number; gi: number }[];
}

export function computeAutoLayout3(
  board: Board,
  components: Component[],
  componentDefs: ComponentDef[],
  nets: Net[],
  netAssignments: NetAssignment[],
  onProgress?: (p: AutoLayoutProgress) => void,
  options?: AutoLayout3Options
): AutoLayoutResult {
  const issues: string[] = [];
  const assignedIds = new Set(netAssignments.map((a) => a.componentId));

  // Locked parts stay put: obstacles with pins, never genes
  const lockedParts = components.filter((c) => c.locked && c.boardPos && !c.boardExcluded);
  const lockedIds = new Set(lockedParts.map((c) => c.id));

  // Parts with no net (or no resolvable def) are left off the board, as in
  // the v2 pipeline; unplaceIds clears any stale position on apply.
  const active: PartInfo[] = [];
  const skippedIds: string[] = [];
  for (const c of components) {
    if (c.boardExcluded || lockedIds.has(c.id)) continue;
    const def = resolveComponentDef(c, componentDefs);
    if (!def || !assignedIds.has(c.id)) {
      skippedIds.push(c.id);
      continue;
    }
    if (def.flexible) {
      const drs = [...allowedDrows(def).entries()]
        .map(([dr, dc]) => ({ dr, dc }))
        .sort((a, b) => a.dr - b.dr);
      if (drs.length === 0) drs.push({ dr: 1, dc: 0 });
      active.push({ comp: c, def, flexible: true, clr: clearanceOf(def), shapes: new Map(), drs });
    } else {
      const shapes = new Map<Rot, RigidShape>();
      for (const rot of ROTS) {
        const b0 = getComponentBounds(def, { row: 0, col: 0 }, rot);
        shapes.set(rot, {
          w: b0.maxCol - b0.minCol + 1,
          h: b0.maxRow - b0.minRow + 1,
          dRow: b0.minRow,
          dCol: b0.minCol,
        });
      }
      active.push({ comp: c, def, flexible: false, clr: 0, shapes, drs: [] });
    }
  }
  // Everything unlocked starts off-board; the decoder places the active set.
  const base: Component[] = components.map((c) =>
    lockedIds.has(c.id)
      ? c
      : {
          ...c,
          boardPos: null,
          flexibleEndPos: undefined,
          rotation: 0 as Rot,
        }
  );

  // Locked geometry: footprints (with their clearance) the decoder's output
  // must not touch, and the board extent they demand.
  const lockedRects: { rect: FootprintRect; clr: number }[] = lockedParts.map((c) => {
    const def = resolveComponentDef(c, componentDefs);
    if (def && !def.flexible) {
      return { rect: getComponentBounds(def, c.boardPos!, c.rotation), clr: 0 };
    }
    const p2 = c.flexibleEndPos ?? c.boardPos!;
    return {
      rect: {
        minRow: Math.min(c.boardPos!.row, p2.row),
        minCol: Math.min(c.boardPos!.col, p2.col),
        maxRow: Math.max(c.boardPos!.row, p2.row),
        maxCol: Math.max(c.boardPos!.col, p2.col),
      },
      clr: def ? clearanceOf(def) : 0,
    };
  });
  const lockedMaxRow = Math.max(-1, ...lockedRects.map((l) => l.rect.maxRow));
  const lockedMaxCol = Math.max(-1, ...lockedRects.map((l) => l.rect.maxCol));

  // Locked board dimensions are hard limits, priced like the v2 chooser
  const limits = {
    ...(board.lockedRows ? { maxRows: board.rows } : {}),
    ...(board.lockedCols ? { maxCols: board.cols } : {}),
  };

  if (active.length === 0) {
    return {
      placements: [],
      cuts: [],
      wires: [],
      issues,
      quality: 0,
      starvedNetIds: [],
      boardSize: { rows: board.rows, cols: board.cols },
      unplaceIds: skippedIds,
    };
  }

  const rng = mulberry32(((options?.seed ?? 0) + 1) * 0x9e3779b9);
  const netByPin = new Map<string, string>();
  for (const a of netAssignments) netByPin.set(pinKey(a.componentId, a.pinId), a.netId);

  // Adjacent same-row pins of different nets force cuts inside the footprint
  // and can leave a pin on a one-hole segment no channel can reach (the
  // horizontal-pin-row trap). Count them per rotation; fewer is healthier —
  // v2's stage-1 "clean rotation" rule, as a score.
  const rowCutScore = (pi: PartInfo, rot: Rot): number => {
    const byRow = new Map<number, { col: number; net: string }[]>();
    for (const p of getRotatedPinPositions(pi.def, { row: 0, col: 0 }, rot)) {
      const n = netByPin.get(pinKey(pi.comp.id, p.pinId));
      if (!n) continue;
      if (!byRow.has(p.row)) byRow.set(p.row, []);
      byRow.get(p.row)!.push({ col: p.col, net: n });
    }
    let s = 0;
    for (const arr of byRow.values()) {
      arr.sort((a, b) => a.col - b.col);
      for (let i = 1; i < arr.length; i++) if (arr[i].net !== arr[i - 1].net) s++;
    }
    return s;
  };

  // ── Cold start: BFS over shared-net adjacency, packed square-ish ─────
  const activeIds = new Set(active.map((p) => p.comp.id));
  const perNet = new Map<string, Set<string>>();
  for (const a of netAssignments) {
    if (!activeIds.has(a.componentId)) continue;
    if (!perNet.has(a.netId)) perNet.set(a.netId, new Set());
    perNet.get(a.netId)!.add(a.componentId);
  }
  const wAdj = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string, w: number) => {
    if (!wAdj.has(a)) wAdj.set(a, new Map());
    const m = wAdj.get(a)!;
    m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const members of perNet.values()) {
    const arr = [...members];
    if (arr.length < 2) continue;
    const w = 1 / (arr.length - 1); // fanout weighting, as in v2 stage 0
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        bump(arr[i], arr[j], w);
        bump(arr[j], arr[i], w);
      }
    }
  }
  const degree = new Map(
    active.map((p) => {
      let d = 0;
      for (const w of (wAdj.get(p.comp.id) ?? new Map()).values()) d += w as number;
      return [p.comp.id, d];
    })
  );
  const piById = new Map(active.map((p) => [p.comp.id, p]));
  const order: PartInfo[] = [];
  const seen = new Set<string>();
  const seeds = [...active].sort(
    (a, b) =>
      degree.get(b.comp.id)! - degree.get(a.comp.id)! ||
      (a.comp.id < b.comp.id ? -1 : 1)
  );
  for (const s of seeds) {
    if (seen.has(s.comp.id)) continue;
    seen.add(s.comp.id);
    const queue = [s.comp.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(piById.get(id)!);
      const nb = [...(wAdj.get(id) ?? new Map<string, number>())]
        .filter(([n]) => !seen.has(n))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      for (const [n] of nb) {
        seen.add(n);
        queue.push(n);
      }
    }
  }

  const defaultGene = (pi: PartInfo): Gene => {
    if (pi.flexible) {
      let di = pi.drs.findIndex((d) => d.dr >= 1);
      if (di < 0) di = 0;
      return { pi, rot: 0, drIdx: di, flip: false };
    }
    let rot: Rot = 0;
    let bestScore = Infinity;
    for (const r of ROTS) {
      const s = rowCutScore(pi, r);
      if (s < bestScore) {
        bestScore = s;
        rot = r;
      }
    }
    return { pi, rot, drIdx: 0, flip: false };
  };
  const soloSlot = (gene: Gene): Slot => ({ gap: 0, pad: 0, genes: [gene] });

  let totalArea = 0;
  for (const pi of order) {
    const { w, h } = dimsOf(defaultGene(pi));
    totalArea += (w + 1) * (h + 1);
  }
  // A locked width is the shape the user wants: pack bands to fill it
  const targetW = limits.maxCols
    ? Math.max(4, limits.maxCols - 2)
    : Math.max(5, Math.round(Math.sqrt(totalArea)));
  const start: Genome = [];
  let bandAcc: Band = { gapAbove: 0, slots: [] };
  let wAcc = 0;
  for (const pi of order) {
    const gene = defaultGene(pi);
    const { w } = dimsOf(gene);
    if (bandAcc.slots.length > 0 && wAcc + w + 1 > targetW) {
      start.push(bandAcc);
      bandAcc = { gapAbove: 0, slots: [] };
      wAcc = 0;
    }
    bandAcc.slots.push(soloSlot(gene));
    wAcc += w + 1;
  }
  if (bandAcc.slots.length > 0) start.push(bandAcc);

  // ── Evaluation: decode, then let the completion router price it ──────
  // evalNets mode routes every net but skips the cosmetic drill upgrade and
  // the final verification recompute; wires never merge different-net
  // copper, so its conflict count matches the full derivation.
  const allNets = new Set(nets.map((n) => n.id));
  const wireCost = options?.wireCost ?? 0;
  const evaluate = (genome: Genome): Evaled => {
    const d = decode(genome, base);
    const rows = Math.max(d.rows, lockedMaxRow + 1);
    const cols = Math.max(d.cols, lockedMaxCol + 1);
    const { virtual, rects } = d;
    // Moving parts decoded onto a locked footprint (or into its clearance
    // moat): a finite geometric penalty, so the decoder stays total and the
    // repair move can steer the offenders away.
    const lockHits: Evaled["lockHits"] = [];
    if (lockedRects.length > 0) {
      for (const r of rects) {
        const gClr = genome[r.bi].slots[r.si].genes[r.gi].pi.clr;
        for (const L of lockedRects) {
          const slack = Math.max(gClr, L.clr);
          if (rectsOverlap(r, L.rect, slack, slack)) {
            lockHits.push({ bi: r.bi, si: r.si, gi: r.gi });
            break;
          }
        }
      }
    }
    const tryBoard: Board = { ...board, rows, cols, cuts: [], wires: [] };
    const plan = deriveCompletion(tryBoard, virtual, componentDefs, nets, netAssignments, {
      evalNets: allNets,
      ...(lockedParts.length > 0 ? { allowSharedJoints: true } : {}),
    });
    let wireLen = 0;
    let slants = 0;
    for (const w of plan.wires) {
      wireLen += Math.hypot(w.from.row - w.to.row, w.from.col - w.to.col);
      if (w.from.col !== w.to.col) slants++;
    }
    const mx = Math.max(rows, cols);
    const mn = Math.min(rows, cols);
    // A user-locked dimension is the user's own shape choice (chooser rule)
    const aspectOver =
      limits.maxRows !== undefined || limits.maxCols !== undefined ? 0 : Math.max(0, mx - 2 * mn) * mn;
    // Locked dimensions are pre-paid in full; exceeding them is penalized
    const areaRows = limits.maxRows ? Math.max(limits.maxRows, rows) : rows;
    const areaCols = limits.maxCols ? Math.max(limits.maxCols, cols) : cols;
    const overCap =
      (limits.maxRows ? Math.max(0, rows - limits.maxRows) : 0) +
      (limits.maxCols ? Math.max(0, cols - limits.maxCols) : 0);
    const bad = plan.unresolvedConflicts * 100 + plan.starvedNetIds.length;
    const cost =
      AREA_WEIGHT * areaRows * areaCols + plan.wireMess + wireLen + aspectOver + mx * slants +
      wireCost * plan.wires.length + bad * 100 + lockHits.length * 150 + overCap * 400 +
      plan.sharedJoints * 30;
    return { cost, bad, rows, cols, starved: plan.starvedPinPositions, rects, lockHits };
  };

  // ── Directed moves: net-aware proposals ──────────────────────────────
  // Random moves alone almost never discover the coincidences that let
  // same-net pins share a strip (the source of v2's low wire counts), so a
  // quarter of proposals aim for them directly: gather a net's members into
  // one band, or snap a part (span/flip of a flex, or its whole slot's pad)
  // so a pin lands on the row where a bandmate has a same-net pin. All read
  // only the static netlist and the genotype, so determinism is untouched.
  const multiNets = [...perNet.entries()]
    .filter(([, m]) => m.size >= 2)
    .map(([net, m]) => ({ net, members: [...m] }));

  // Connected pins of one gene: net + row offset from the gene's own top
  const genePinRows = (gene: Gene): { net: string; row: number }[] => {
    const out: { net: string; row: number }[] = [];
    if (gene.pi.flexible) {
      const d = gene.pi.drs[gene.drIdx];
      const p0 = gene.pi.def.pins[0];
      const p1 = gene.pi.def.pins[1];
      const n0 = p0 && netByPin.get(pinKey(gene.pi.comp.id, p0.id));
      const n1 = p1 && netByPin.get(pinKey(gene.pi.comp.id, p1.id));
      if (n0) out.push({ net: n0, row: gene.flip ? d.dr : 0 });
      if (n1) out.push({ net: n1, row: gene.flip ? 0 : d.dr });
    } else {
      const s = gene.pi.shapes.get(gene.rot)!;
      for (const p of getRotatedPinPositions(gene.pi.def, { row: 0, col: 0 }, gene.rot)) {
        const n = netByPin.get(pinKey(gene.pi.comp.id, p.pinId));
        if (n) out.push({ net: n, row: p.row - s.dRow });
      }
    }
    return out;
  };

  // ── Move set (every move yields a valid genotype) ────────────────────
  const cloneG = (g: Genome): Genome =>
    g.map((b) => ({
      gapAbove: b.gapAbove,
      slots: b.slots.map((s) => ({ gap: s.gap, pad: s.pad, genes: [...s.genes] })),
    }));
  const dropEmpty = (g: Genome) => {
    for (const b of g) {
      for (let i = b.slots.length - 1; i >= 0; i--) if (b.slots[i].genes.length === 0) b.slots.splice(i, 1);
    }
    for (let i = g.length - 1; i >= 0; i--) if (g[i].slots.length === 0) g.splice(i, 1);
  };
  interface Pos {
    bi: number;
    si: number;
    gi: number;
  }
  // Coordinated row reclaims, shared by the anneal's stochastic branch and
  // the greedy polish sweep. Both edit many genes in one proposal — the
  // moves a single-gene neighbourhood cannot reach (one flex leaving its
  // shared net row costs a wire and gets rejected; all of them together is
  // free or better).
  const collapseAt = (g0: Genome, rects: GeneRect[], y: number): Genome | null => {
    const g = cloneG(g0);
    const ext = new Map<number, { lo: number; hi: number }>();
    for (const rect of rects) {
      const e = ext.get(rect.bi);
      if (!e) ext.set(rect.bi, { lo: rect.minRow, hi: rect.maxRow });
      else {
        if (rect.minRow < e.lo) e.lo = rect.minRow;
        if (rect.maxRow > e.hi) e.hi = rect.maxRow;
      }
    }
    let inBand = -1;
    for (const [bi, e] of ext) {
      if (y >= e.lo && y <= e.hi) {
        inBand = bi;
        break;
      }
    }
    if (inBand >= 0) {
      if (inBand >= g.length) return null;
      const tops = new Map<number, number>();
      for (const rect of rects) {
        if (rect.bi !== inBand) continue;
        const t = tops.get(rect.si);
        if (t === undefined || rect.minRow < t) tops.set(rect.si, rect.minRow);
      }
      let changed = 0;
      for (const [si, top] of tops) {
        if (top > y && si < g[inBand].slots.length && g[inBand].slots[si].pad > 0) {
          g[inBand].slots[si] = { ...g[inBand].slots[si], pad: g[inBand].slots[si].pad - 1 };
          changed++;
        }
      }
      return changed > 0 ? g : null;
    }
    let below = -1;
    let belowLo = Infinity;
    for (const [bi, e] of ext) {
      if (e.lo > y && e.lo < belowLo) {
        belowLo = e.lo;
        below = bi;
      }
    }
    if (below < 0 || below >= g.length || g[below].gapAbove === 0) return null;
    g[below] = { ...g[below], gapAbove: g[below].gapAbove - 1 };
    return g;
  };
  const liftAt = (g0: Genome, rects: GeneRect[], row: number): Genome | null => {
    const g = cloneG(g0);
    let n = 0;
    for (const rect of rects) {
      if (rect.maxRow !== row) continue;
      if (rect.bi >= g.length || rect.si >= g[rect.bi].slots.length) continue;
      const slot = g[rect.bi].slots[rect.si];
      if (rect.gi >= slot.genes.length) continue;
      const gene = slot.genes[rect.gi];
      if (!gene.pi.flexible) continue;
      const d = gene.pi.drs[gene.drIdx];
      const ni = gene.pi.drs.findIndex((x) => x.dr === d.dr - 1);
      if (ni < 0) return null; // a stuck span cancels the lift: the strip never fragments
      slot.genes[rect.gi] = { ...gene, drIdx: ni };
      n++;
    }
    return n > 0 ? g : null;
  };
  const mutate = (g0: Genome, ctx?: Evaled): Genome | null => {
    const g = cloneG(g0);
    const pos: Pos[] = [];
    g.forEach((b, bi) => b.slots.forEach((s, si) => s.genes.forEach((_, gi) => pos.push({ bi, si, gi }))));
    if (pos.length === 0) return null;
    const pickPos = () => pos[Math.floor(rng() * pos.length)];
    const takeGene = (p: Pos): Gene => g[p.bi].slots[p.si].genes.splice(p.gi, 1)[0];
    const insertGene = (bi: number, gene: Gene) => {
      const band = g[bi];
      if (band.slots.length > 0 && rng() < 0.5) {
        // stack into an existing slot at a random depth
        const slot = band.slots[Math.floor(rng() * band.slots.length)];
        slot.genes.splice(Math.floor(rng() * (slot.genes.length + 1)), 0, gene);
      } else {
        band.slots.splice(Math.floor(rng() * (band.slots.length + 1)), 0, soloSlot(gene));
      }
    };
    // Directed lock repair: a gene decoded onto a locked footprint is
    // shoved (pad down / gap right) or relocated outright.
    if (ctx && ctx.lockHits.length > 0 && rng() < 0.5) {
      const hit = ctx.lockHits[Math.floor(rng() * ctx.lockHits.length)];
      if (hit.bi >= g.length || hit.si >= g[hit.bi].slots.length) return null;
      const slot = g[hit.bi].slots[hit.si];
      if (hit.gi >= slot.genes.length) return null;
      const dice = rng();
      if (dice < 0.4) {
        const gene = takeGene(hit);
        if (rng() < 0.2) {
          g.splice(Math.floor(rng() * (g.length + 1)), 0, { gapAbove: 0, slots: [soloSlot(gene)] });
        } else {
          insertGene(Math.floor(rng() * g.length), gene);
        }
        dropEmpty(g);
      } else if (dice < 0.7 && slot.pad < MAX_PAD) {
        g[hit.bi].slots[hit.si] = { ...slot, pad: slot.pad + 1 };
      } else if (slot.gap < MAX_GAP) {
        g[hit.bi].slots[hit.si] = { ...slot, gap: slot.gap + 1 };
      } else {
        return null;
      }
      return g;
    }
    // Directed repair: a starved segment has no free hole for its link wire.
    // Either open an anchored channel column beside the starving part (the
    // new column extends every strip the part spans with a free hole —
    // v2's IC-channel insertion recast as a move), or rotate the part
    // itself: a starved pin inside a horizontal pin row cannot be rescued
    // by any channel, the cuts sit inside the footprint.
    if (ctx && ctx.starved.length > 0 && rng() < 0.35) {
      const p = ctx.starved[Math.floor(rng() * ctx.starved.length)];
      let bestR: GeneRect | null = null;
      let bestD = Infinity;
      for (const rect of ctx.rects) {
        const d =
          (p.row < rect.minRow ? rect.minRow - p.row : p.row > rect.maxRow ? p.row - rect.maxRow : 0) +
          (p.col < rect.minCol ? rect.minCol - p.col : p.col > rect.maxCol ? p.col - rect.maxCol : 0);
        if (d < bestD) {
          bestD = d;
          bestR = rect;
        }
      }
      if (!bestR || bestR.bi >= g.length || bestR.si >= g[bestR.bi].slots.length) return null;
      const slots = g[bestR.bi].slots;
      const starvGene = slots[bestR.si].genes[bestR.gi];
      if (starvGene && !starvGene.pi.flexible && rng() < 0.5) {
        const opts = ROTS.filter((x) => x !== starvGene.rot).sort(
          (a, b) => rowCutScore(starvGene.pi, a) - rowCutScore(starvGene.pi, b)
        );
        const pickIdx = rng() < 0.7 ? 0 : 1 + Math.floor(rng() * (opts.length - 1));
        slots[bestR.si].genes[bestR.gi] = { ...starvGene, rot: opts[pickIdx] };
        return g;
      }
      const cand = [bestR.si, bestR.si + 1].filter((i) => i < slots.length && slots[i].gap < MAX_GAP);
      if (cand.length === 0) return null;
      const i = cand[Math.floor(rng() * cand.length)];
      slots[i] = { ...slots[i], gap: slots[i].gap + 1 };
      return g;
    }
    const r = rng();
    if (r < 0.08) {
      // row-collapse / strip-lift (directed): reclaim a row the decoder
      // left idle. These are coordinated multi-gene edits a single-gene
      // move cannot reach: one flex leaving its shared net row costs a
      // wire and gets rejected (and pin-snap would drag it back), while
      // moving every participant together is free or better.
      if (!ctx) return null;
      if (rng() < 0.5) {
        // A: an empty decoded row -> shrink the pads/gap that create it
        const covered = new Set<number>();
        let maxRow = 0;
        for (const rect of ctx.rects) {
          for (let y = rect.minRow; y <= rect.maxRow; y++) covered.add(y);
          if (rect.maxRow > maxRow) maxRow = rect.maxRow;
        }
        const empties: number[] = [];
        for (let y = 0; y < maxRow; y++) if (!covered.has(y)) empties.push(y);
        if (empties.length === 0) return null;
        return collapseAt(g0, ctx.rects, empties[Math.floor(rng() * empties.length)]);
      }
      // B: strip-lift — every flex whose bottom pin sits on one shared
      // decoded row shortens by one, moving the whole net row up
      const bottoms: number[] = [];
      const seenB = new Set<number>();
      for (const rect of ctx.rects) {
        if (seenB.has(rect.maxRow)) continue;
        const slot = g0[rect.bi]?.slots[rect.si];
        const gene = slot?.genes[rect.gi];
        if (!gene || !gene.pi.flexible) continue;
        seenB.add(rect.maxRow);
        bottoms.push(rect.maxRow);
      }
      if (bottoms.length === 0) return null;
      return liftAt(g0, ctx.rects, bottoms[Math.floor(rng() * bottoms.length)]);
    } else if (r < 0.2) {
      // net-gather (directed): move one member of a band-fragmented net
      // next to another member of the same net
      if (multiNets.length === 0) return null;
      const pick = multiNets[Math.floor(rng() * multiNets.length)];
      const loc = new Map<string, Pos>();
      g.forEach((b, bi) => b.slots.forEach((s, si) => s.genes.forEach((gene, gi) => loc.set(gene.pi.comp.id, { bi, si, gi }))));
      const members = pick.members.filter((id) => loc.has(id));
      if (members.length < 2) return null;
      const aId = members[Math.floor(rng() * members.length)];
      const aLoc = loc.get(aId)!;
      const others = members.filter((id) => loc.get(id)!.bi !== aLoc.bi);
      if (others.length === 0) return null;
      const bLoc = loc.get(others[Math.floor(rng() * others.length)])!;
      const gene = takeGene(aLoc);
      const bSlots = g[bLoc.bi].slots;
      if (rng() < 0.25) {
        // stack directly against the target member
        bSlots[bLoc.si].genes.splice(bLoc.gi + (rng() < 0.5 ? 0 : 1), 0, gene);
      } else {
        // fresh slot beside the target's slot; pin/pad-snap aligns later
        const at = Math.min(bLoc.si + (rng() < 0.5 ? 0 : 1), bSlots.length);
        bSlots.splice(at, 0, soloSlot(gene));
      }
    } else if (r < 0.3) {
      // pin/pad-snap (directed): make one of a part's pins land on the row
      // where a bandmate carries the same net — by retuning a flexible
      // part's span/flip, or by shifting its whole slot's pad
      const { bi, si, gi } = pickPos();
      const band = g[bi];
      const slot = band.slots[si];
      const gene = slot.genes[gi];
      const targets: { net: string; row: number }[] = [];
      band.slots.forEach((s, osi) => {
        const { offs } = stackOffsets(s);
        s.genes.forEach((other, ogi) => {
          if (osi === si && ogi === gi) return;
          for (const t of genePinRows(other)) targets.push({ net: t.net, row: s.pad + offs[ogi] + t.row });
        });
      });
      if (targets.length === 0) return null;
      const own = genePinRows(gene);
      const shared = targets.filter((t) => own.some((o) => o.net === t.net));
      if (shared.length === 0) return null;
      const tgt = shared[Math.floor(rng() * shared.length)];
      const off = stackOffsets(slot).offs[gi];
      type Fix = { kind: "gene"; drIdx: number; flip: boolean } | { kind: "pad"; pad: number };
      const fixes: Fix[] = [];
      if (gene.pi.flexible) {
        const p0 = gene.pi.def.pins[0];
        const p1 = gene.pi.def.pins[1];
        const n0 = p0 && netByPin.get(pinKey(gene.pi.comp.id, p0.id));
        const n1 = p1 && netByPin.get(pinKey(gene.pi.comp.id, p1.id));
        gene.pi.drs.forEach((d, di) => {
          for (const flip of [false, true]) {
            const r0 = flip ? d.dr : 0;
            const r1 = flip ? 0 : d.dr;
            const base0 = slot.pad + off;
            if ((n0 === tgt.net && base0 + r0 === tgt.row) || (n1 === tgt.net && base0 + r1 === tgt.row)) {
              if (di !== gene.drIdx || flip !== gene.flip) fixes.push({ kind: "gene", drIdx: di, flip });
            }
          }
        });
      }
      for (const o of own) {
        if (o.net !== tgt.net) continue;
        const pad = tgt.row - off - o.row;
        if (pad >= 0 && pad <= MAX_PAD && pad !== slot.pad) fixes.push({ kind: "pad", pad });
      }
      if (fixes.length === 0) return null;
      const fix = fixes[Math.floor(rng() * fixes.length)];
      if (fix.kind === "gene") slot.genes[gi] = { ...gene, drIdx: fix.drIdx, flip: fix.flip };
      else band.slots[si] = { ...slot, pad: fix.pad };
    } else if (r < 0.48) {
      // relocate a part (into another band's slot or a fresh slot,
      // sometimes to a fresh band of its own)
      const p = pickPos();
      const gene = takeGene(p);
      if (rng() < 0.15) {
        const at = Math.floor(rng() * (g.length + 1));
        g.splice(at, 0, { gapAbove: 0, slots: [soloSlot(gene)] });
      } else {
        insertGene(Math.floor(rng() * g.length), gene);
      }
    } else if (r < 0.62) {
      // swap two parts
      if (pos.length < 2) return null;
      const a = pickPos();
      let b = pickPos();
      let guard = 0;
      while (b.bi === a.bi && b.si === a.si && b.gi === a.gi && guard++ < 5) b = pickPos();
      if (b.bi === a.bi && b.si === a.si && b.gi === a.gi) return null;
      const ga = g[a.bi].slots[a.si].genes[a.gi];
      g[a.bi].slots[a.si].genes[a.gi] = g[b.bi].slots[b.si].genes[b.gi];
      g[b.bi].slots[b.si].genes[b.gi] = ga;
    } else if (r < 0.76) {
      // reorient: rotation (rigid) or span/flip (flexible)
      const { bi, si, gi } = pickPos();
      const gene = g[bi].slots[si].genes[gi];
      if (gene.pi.flexible) {
        if (rng() < 0.4 || gene.pi.drs.length < 2) {
          g[bi].slots[si].genes[gi] = { ...gene, flip: !gene.flip };
        } else {
          let idx = Math.floor(rng() * gene.pi.drs.length);
          if (idx === gene.drIdx) idx = (idx + 1) % gene.pi.drs.length;
          g[bi].slots[si].genes[gi] = { ...gene, drIdx: idx };
        }
      } else {
        const opts = ROTS.filter((x) => x !== gene.rot);
        g[bi].slots[si].genes[gi] = { ...gene, rot: opts[Math.floor(rng() * opts.length)] };
      }
    } else if (r < 0.86) {
      // widen/narrow a slot's channel columns, or shift its pad rows
      const { bi, si } = pickPos();
      const slot = g[bi].slots[si];
      if (rng() < 0.5) {
        const ng = Math.max(0, Math.min(MAX_GAP, slot.gap + (rng() < 0.5 ? -1 : 1)));
        if (ng === slot.gap) return null;
        g[bi].slots[si] = { ...slot, gap: ng };
      } else {
        const np = Math.max(0, Math.min(MAX_PAD, slot.pad + (rng() < 0.5 ? -1 : 1)));
        if (np === slot.pad) return null;
        g[bi].slots[si] = { ...slot, pad: np };
      }
    } else if (r < 0.9) {
      // widen/narrow the free rows above a band
      const bi = Math.floor(rng() * g.length);
      const nb = Math.max(0, Math.min(2, g[bi].gapAbove + (rng() < 0.5 ? -1 : 1)));
      if (nb === g[bi].gapAbove) return null;
      g[bi] = { ...g[bi], gapAbove: nb };
    } else {
      // merge two adjacent bands, or split one
      if (rng() < 0.5 && g.length >= 2) {
        const bi = Math.floor(rng() * (g.length - 1));
        g[bi] = { gapAbove: g[bi].gapAbove, slots: [...g[bi].slots, ...g[bi + 1].slots] };
        g.splice(bi + 1, 1);
      } else {
        const cands: number[] = [];
        g.forEach((b, i) => {
          if (b.slots.length >= 2) cands.push(i);
        });
        if (cands.length === 0) return null;
        const i = cands[Math.floor(rng() * cands.length)];
        const at = 1 + Math.floor(rng() * (g[i].slots.length - 1));
        const first: Band = { gapAbove: g[i].gapAbove, slots: g[i].slots.slice(0, at) };
        const second: Band = { gapAbove: 0, slots: g[i].slots.slice(at) };
        g.splice(i, 1, first, second);
      }
    }
    dropEmpty(g);
    return g;
  };

  // Warm start: band/slot readout of an existing layout. Vertically
  // separable runs become bands; within a band, column-overlapping parts
  // stack into one slot (top-to-bottom order preserved) and the slot's pad
  // keeps its vertical registration inside the band. Rotations, spans and
  // flips survive; exact column offsets inside a slot do not.
  const warmGenome = (placements: LayoutPlacement[]): Genome => {
    const byId = new Map(placements.map((p) => [p.componentId, p]));
    interface E {
      top: number;
      bottom: number;
      left: number;
      right: number;
      gene: Gene;
    }
    const entries: E[] = [];
    const leftovers: PartInfo[] = [];
    for (const pi of active) {
      const p = byId.get(pi.comp.id);
      if (!p || !p.boardPos) {
        leftovers.push(pi);
        continue;
      }
      if (pi.flexible) {
        const p1 = p.boardPos;
        const p2 = p.flexibleEndPos ?? p.boardPos;
        const dr = Math.abs(p1.row - p2.row);
        let drIdx = pi.drs.findIndex((d) => d.dr === dr);
        if (drIdx < 0) {
          let bd = Infinity;
          pi.drs.forEach((d, i) => {
            const dd = Math.abs(d.dr - dr);
            if (dd < bd) {
              bd = dd;
              drIdx = i;
            }
          });
        }
        const d = pi.drs[drIdx];
        const flip = dr > 0 ? p1.row > p2.row : p1.col > p2.col;
        const top = Math.min(p1.row, p2.row);
        const left = Math.min(p1.col, p2.col);
        entries.push({ top, bottom: top + d.dr, left, right: left + d.dc, gene: { pi, rot: 0, drIdx, flip } });
      } else {
        const rot = (p.rotation ?? 0) as Rot;
        const s = pi.shapes.get(rot)!;
        const top = p.boardPos.row + s.dRow;
        const left = p.boardPos.col + s.dCol;
        entries.push({ top, bottom: top + s.h - 1, left, right: left + s.w - 1, gene: { pi, rot, drIdx: 0, flip: false } });
      }
    }
    entries.sort((a, b) => a.top - b.top || a.left - b.left);
    // vertically separable runs -> bands
    const groups: E[][] = [];
    let cut = -1;
    for (const e of entries) {
      if (groups.length === 0 || e.top > cut) {
        groups.push([]);
        cut = e.bottom;
      } else if (e.bottom > cut) {
        cut = e.bottom;
      }
      groups[groups.length - 1].push(e);
    }
    const genome: Genome = [];
    for (const grp of groups) {
      const bandTop = Math.min(...grp.map((e) => e.top));
      grp.sort((a, b) => a.left - b.left || a.top - b.top);
      const slots: { hi: number; list: E[] }[] = [];
      for (const e of grp) {
        const last = slots[slots.length - 1];
        if (last && e.left <= last.hi) {
          last.list.push(e);
          if (e.right > last.hi) last.hi = e.right;
        } else {
          slots.push({ hi: e.right, list: [e] });
        }
      }
      genome.push({
        gapAbove: 0,
        slots: slots.map((s) => {
          s.list.sort((a, b) => a.top - b.top);
          return {
            gap: 0,
            pad: Math.min(MAX_PAD, s.list[0].top - bandTop),
            genes: s.list.map((e) => e.gene),
          };
        }),
      });
    }
    for (const pi of leftovers) genome.push({ gapAbove: 0, slots: [soloSlot(defaultGene(pi))] });
    return genome;
  };

  // ── Annealing ────────────────────────────────────────────────────────
  let cur = options?.warmStart ? warmGenome(options.warmStart) : start;
  let curE = evaluate(cur);
  let best = cur;
  let bestE = curE;

  // Greedy polish: exhaustively try the coordinated row reclaims (and the
  // single-gene slack decrements) on the incumbent, to a fixpoint. The
  // anneal only samples these; at the incumbent they deserve a systematic
  // sweep — a human scans the finished board for exactly these rows.
  const polish = () => {
    for (let round = 0; round < 40; round++) {
      const rects = bestE.rects;
      const cands: (Genome | null)[] = [];
      const covered = new Set<number>();
      let maxRow = 0;
      for (const rect of rects) {
        for (let y = rect.minRow; y <= rect.maxRow; y++) covered.add(y);
        if (rect.maxRow > maxRow) maxRow = rect.maxRow;
      }
      for (let y = 0; y < maxRow; y++) if (!covered.has(y)) cands.push(collapseAt(best, rects, y));
      const seenB = new Set<number>();
      for (const rect of rects) {
        if (seenB.has(rect.maxRow)) continue;
        const gene = best[rect.bi]?.slots[rect.si]?.genes[rect.gi];
        if (!gene || !gene.pi.flexible) continue;
        seenB.add(rect.maxRow);
        cands.push(liftAt(best, rects, rect.maxRow));
      }
      best.forEach((b, bi) => {
        if (b.gapAbove > 0) {
          const g = cloneG(best);
          g[bi] = { ...g[bi], gapAbove: g[bi].gapAbove - 1 };
          cands.push(g);
        }
        b.slots.forEach((sl, si) => {
          if (sl.pad > 0) {
            const g = cloneG(best);
            g[bi].slots[si] = { ...g[bi].slots[si], pad: g[bi].slots[si].pad - 1 };
            cands.push(g);
          }
          if (sl.gap > 0) {
            const g = cloneG(best);
            g[bi].slots[si] = { ...g[bi].slots[si], gap: g[bi].slots[si].gap - 1 };
            cands.push(g);
          }
        });
      });
      let took = false;
      for (const cand of cands) {
        if (!cand) continue;
        const e = evaluate(cand);
        if (e.cost < bestE.cost - 1e-9) {
          best = cand;
          bestE = e;
          took = true;
          break;
        }
      }
      if (!took) break;
    }
  };
  polish();
  cur = best;
  curE = bestE;

  // T0 calibration: random-walk a few moves, aim to accept a typical uphill
  // step with ~80% probability at the start of the schedule.
  const ups: number[] = [];
  for (let i = 0; i < 60; i++) {
    const m = mutate(cur, curE);
    if (!m) continue;
    const e = evaluate(m);
    if (e.cost > curE.cost) ups.push(e.cost - curE.cost);
  }
  ups.sort((a, b) => a - b);
  const typUp = ups.length > 0 ? ups[Math.floor(ups.length * 0.7)] : 10;
  // Warm starts run cooler: polish the inherited structure, don't melt it
  const acc0 = options?.warmStart ? 0.25 : 0.8;
  const t0 = Math.max(1, typUp) / Math.log(1 / acc0);
  const iters =
    options?.moves !== undefined
      ? Math.max(0, options.moves)
      : Math.min(12000, 3000 + 200 * active.length);
  const tEnd = 0.5;
  const cool = Math.pow(tEnd / t0, 1 / iters);
  let T = t0;

  for (let i = 0; i < iters; i++) {
    T *= cool;
    const m = mutate(cur, curE);
    if (!m) continue;
    const e = evaluate(m);
    const dE = e.cost - curE.cost;
    const accepted = dE <= 0 || rng() < Math.exp(-dE / T);
    if (accepted) {
      cur = m;
      curE = e;
      if (e.cost < bestE.cost) {
        best = m;
        bestE = e;
      }
    }
    options?.onStat?.({ iter: i, T, cost: curE.cost, best: bestE.cost, accepted });
    if (onProgress && i % 200 === 0) {
      onProgress({ phase: "place", attempt: 1, maxAttempts: 1, frac: (0.9 * i) / iters });
    }
  }

  polish();

  // ── Finish: full derivation, then the shared v2 passes ───────────────
  const dBest = decode(best, base);
  const virtual = dBest.virtual;
  const rows = Math.max(dBest.rows, lockedMaxRow + 1);
  const cols = Math.max(dBest.cols, lockedMaxCol + 1);
  const movedIds = new Set(active.map((p) => p.comp.id));
  const chooser = new Chooser(board, componentDefs, nets, netAssignments, lockedParts.length > 0, limits, false);
  chooser.route(virtual, rows, cols, movedIds);
  chooser.freezePool();
  if (options?.finisher !== false) {
    const netOfPin = new Map<string, string>();
    for (const a of netAssignments) netOfPin.set(pinKey(a.componentId, a.pinId), a.netId);
    const c0 = chooser.chosen!;
    // Compaction and channel insertion shift content; with locked parts the
    // content must not move relative to them (v2's own gating rule)
    if (c0.bad === 0 && lockedParts.length === 0) {
      const full = compactPlacements(c0.virtual, componentDefs, netOfPin, c0.rows, c0.cols);
      if (full.removals > 0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds);
      insertWireChannels(chooser, componentDefs, limits, false);
    }
    if (chooser.chosen!.bad === 0) {
      repairSlantWires(chooser, board, componentDefs, netAssignments, lockedIds);
    }
  }
  const chosen = chooser.chosen!;
  const { plan } = chosen;

  const placements: LayoutPlacement[] = [];
  for (const c of chosen.virtual) {
    if (!movedIds.has(c.id) || !c.boardPos) continue;
    const def = resolveComponentDef(c, componentDefs);
    placements.push(
      def?.flexible
        ? { componentId: c.id, boardPos: c.boardPos, flexibleEndPos: c.flexibleEndPos }
        : { componentId: c.id, boardPos: c.boardPos, rotation: c.rotation }
    );
  }
  issues.push(...plan.issues);
  if (plan.unresolvedConflicts > 0) {
    issues.push(
      `${plan.unresolvedConflicts} conflict${plan.unresolvedConflicts > 1 ? "s" : ""} could not be resolved`
    );
  }
  // A locked dimension stays exactly at the user's value: the physical
  // board doesn't shrink, and overflowing it is reported, not hidden.
  if (board.lockedRows && chosen.rows > board.rows) {
    issues.push(`does not fit the locked ${board.rows} rows (needs ${chosen.rows})`);
  }
  if (board.lockedCols && chosen.cols > board.cols) {
    issues.push(`does not fit the locked ${board.cols} columns (needs ${chosen.cols})`);
  }
  const outRows = board.lockedRows ? Math.max(board.rows, chosen.rows) : chosen.rows;
  const outCols = board.lockedCols ? Math.max(board.cols, chosen.cols) : chosen.cols;

  const finalBoard: Board = {
    ...board,
    rows: outRows,
    cols: outCols,
    cuts: plan.cuts,
    wires: plan.wires.map((w, i) => ({ id: `v3-${i}`, from: w.from, to: w.to })),
  };
  const segments = computeStripSegments(finalBoard, chosen.virtual, componentDefs, netAssignments);
  const connectivity = computeConnectivity(segments, finalBoard.wires);
  const conflicts = connectivity.filter((g) => g.hasConflict).length;
  const incomplete = checkNetCompleteness(
    nets, netAssignments, segments, connectivity, chosen.virtual, componentDefs
  );
  // A moving part still decoded onto a locked footprint is a physically
  // broken board: the anneal prices it, but if one survives it must be
  // reported, never silently shipped (the connectivity checks cannot see
  // body overlaps).
  if (bestE.lockHits.length > 0) {
    issues.push(
      `${bestE.lockHits.length} part${bestE.lockHits.length > 1 ? "s" : ""} could not be placed clear of a locked component`
    );
  }
  const quality = conflicts * 100 + incomplete.length + bestE.lockHits.length * 2;
  onProgress?.({ phase: "place", attempt: 1, maxAttempts: 1, frac: 1 });

  return {
    placements,
    cuts: plan.cuts,
    wires: plan.wires,
    issues,
    quality,
    starvedNetIds: plan.starvedNetIds,
    boardSize: { rows: outRows, cols: outCols },
    unplaceIds: skippedIds,
    tiles: best.length, // band count, for curiosity
  };
}
