import { RUNTIME_BANDS } from "./data";

/**
 * Hand-drawn SVG figures. Inline JSX so they inherit the page's fonts and
 * follow light/dark mode through Tailwind classes, and compile into the
 * static page at build time like the rest of the prose.
 */

const boxCls = "fill-none stroke-neutral-300 dark:stroke-neutral-600";
const stageCls = "fill-[var(--copper)] font-mono text-[9px] uppercase tracking-[0.15em]";
const titleCls = "fill-neutral-800 dark:fill-neutral-200 font-serif text-[12.5px]";
const subCls = "fill-neutral-500 dark:fill-neutral-400 font-serif text-[10.5px]";
const pillTextCls = "fill-neutral-600 dark:fill-neutral-300 font-mono text-[10px] uppercase tracking-[0.12em]";
const flowCls = "stroke-neutral-400 dark:stroke-neutral-500";
const proposeCls = "stroke-neutral-300 dark:stroke-neutral-600";

function Node({ x, y, w, h, stage, title, sub, sub2 }: {
  x: number; y: number; w: number; h: number;
  stage?: string; title: string; sub?: string; sub2?: string;
}) {
  const cx = x + w / 2;
  const titleY = stage ? y + 30 : y + 22;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} className={boxCls} />
      {stage && (
        <text x={cx} y={y + 15} textAnchor="middle" className={stageCls}>
          {stage}
        </text>
      )}
      <text x={cx} y={titleY} textAnchor="middle" className={titleCls}>
        {title}
      </text>
      {sub && (
        <text x={cx} y={titleY + 13} textAnchor="middle" className={subCls}>
          {sub}
        </text>
      )}
      {sub2 && (
        <text x={cx} y={titleY + 25} textAnchor="middle" className={subCls}>
          {sub2}
        </text>
      )}
    </g>
  );
}

function Pill({ x, y, w, label, accent }: { x: number; y: number; w: number; label: string; accent?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={28}
        rx={14}
        className={accent ? "fill-none stroke-[var(--copper)]" : boxCls}
      />
      <text x={x + w / 2} y={y + 18} textAnchor="middle" className={pillTextCls}>
        {label}
      </text>
    </g>
  );
}

/** Fig. 1: the pipeline of Section 4, with the chooser on the main path. */
export function FigPipeline() {
  return (
    <div className="overflow-x-auto">
      <svg viewBox="0 0 740 244" className="w-full h-auto min-w-[640px]" role="img" aria-label="Flow diagram of the solver pipeline: netlist, clustering, strip assignment, floorplanning, cut and wire derivation, then the chooser, refinement and the tidy pass leading to the finished board">
        <defs>
          <marker id="fig1-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="fill-neutral-400 dark:fill-neutral-500" />
          </marker>
        </defs>

        {/* construction row */}
        <Pill x={8} y={28} w={72} label="netlist" />
        <Node x={104} y={16} w={140} h={52} stage="stage 0" title="Cluster the netlist" sub="supply nets self-neutralise" />
        <Node x={262} y={16} w={150} h={52} stage="stage 1" title="Nets onto strip rows" sub="one tile per group" />
        <Node x={430} y={16} w={140} h={52} stage="stage 2" title="Floorplan the tiles" sub="row alignment joins copper" />
        <Node x={588} y={16} w={144} h={52} stage="stage 3" title="Derive cuts and wires" sub="completion from geometry" />
        <line x1={82} y1={42} x2={100} y2={42} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={246} y1={42} x2={258} y2={42} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={414} y1={42} x2={426} y2={42} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={572} y1={42} x2={584} y2={42} className={flowCls} markerEnd="url(#fig1-arrow)" />

        {/* the one chooser, on the main path */}
        <rect x={104} y={108} width={628} height={34} rx={6} className="fill-none stroke-[var(--copper)]" strokeDasharray="5 4" />
        <text x={418} y={129} textAnchor="middle">
          <tspan className={stageCls}>chooser&nbsp;&nbsp;</tspan>
          <tspan className={subCls}>every candidate passes here and is adopted only if strictly better (Section 5)</tspan>
        </text>
        <line x1={660} y1={68} x2={660} y2={104} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={500} y1={68} x2={500} y2={104} className={proposeCls} strokeDasharray="3 3" markerEnd="url(#fig1-arrow)" />

        {/* improvement row */}
        <Node x={430} y={178} w={170} h={58} title="Refinement" sub="compaction, annealing," sub2="channels, off-axis repair" />
        <Node x={230} y={178} w={160} h={58} title="Tidy pass" sub="re-solved with its own" sub2="width imposed as a lock" />
        <Pill x={8} y={193} w={72} label="board" accent />
        <line x1={515} y1={146} x2={515} y2={174} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={426} y1={207} x2={394} y2={207} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={226} y1={207} x2={86} y2={207} className={flowCls} markerEnd="url(#fig1-arrow)" />
        <line x1={560} y1={174} x2={560} y2={146} className={proposeCls} strokeDasharray="3 3" markerEnd="url(#fig1-arrow)" />
        <line x1={310} y1={174} x2={310} y2={146} className={proposeCls} strokeDasharray="3 3" markerEnd="url(#fig1-arrow)" />
      </svg>
    </div>
  );
}


// ── Fig 2: solve time by project size ──────────────────

/** Log-scale box plot of single-ordering solve time, one box per size band
 * (parts rounded to a multiple of 5). Whiskers span min to max; the box is
 * the interquartile range with a tick at the median. */
export function FigRuntime() {
  const W = 640, H = 300;
  const left = 52, right = 14, top = 12, bottom = 34;
  const plotW = W - left - right, plotH = H - top - bottom;
  const lo = Math.log10(3), hi = Math.log10(80000);
  const y = (ms: number) => top + plotH - ((Math.log10(ms) - lo) / (hi - lo)) * plotH;
  const step = plotW / RUNTIME_BANDS.length;
  const x = (i: number) => left + step * (i + 0.5);
  const boxW = Math.min(26, step * 0.5);
  const gridMs = [10, 100, 1000, 10000, 60000];
  const gridLabel = (ms: number) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);
  const axisCls = "stroke-neutral-300 dark:stroke-neutral-600";
  const gridCls = "stroke-neutral-200 dark:stroke-neutral-700";
  const tickCls = "fill-neutral-500 dark:fill-neutral-400 font-mono text-[9.5px]";
  const nCls = "fill-neutral-400 dark:fill-neutral-500 font-mono text-[8.5px]";
  const boxFill = "fill-[var(--copper)]/15 stroke-[var(--copper)]";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Box plot of solve time by component count" className="w-full h-auto">
      {gridMs.map((ms) => (
        <g key={ms}>
          <line x1={left} y1={y(ms)} x2={W - right} y2={y(ms)} className={gridCls} strokeDasharray="2 4" />
          <text x={left - 6} y={y(ms) + 3} textAnchor="end" className={tickCls}>
            {gridLabel(ms)}
          </text>
        </g>
      ))}
      <line x1={left} y1={top} x2={left} y2={top + plotH} className={axisCls} />
      <line x1={left} y1={top + plotH} x2={W - right} y2={top + plotH} className={axisCls} />
      {RUNTIME_BANDS.map((b, i) => {
        const cx = x(i);
        return (
          <g key={b.band} className={boxFill}>
            <line x1={cx} y1={y(b.min)} x2={cx} y2={y(b.q1)} />
            <line x1={cx} y1={y(b.q3)} x2={cx} y2={y(b.max)} />
            <line x1={cx - boxW / 4} y1={y(b.min)} x2={cx + boxW / 4} y2={y(b.min)} />
            <line x1={cx - boxW / 4} y1={y(b.max)} x2={cx + boxW / 4} y2={y(b.max)} />
            <rect x={cx - boxW / 2} y={y(b.q3)} width={boxW} height={Math.max(1, y(b.q1) - y(b.q3))} rx={2} />
            <line x1={cx - boxW / 2} y1={y(b.med)} x2={cx + boxW / 2} y2={y(b.med)} strokeWidth={2} />
            <text x={cx} y={top + plotH + 14} textAnchor="middle" className={tickCls} stroke="none">
              {b.band}
            </text>
            <text x={cx} y={top + plotH + 26} textAnchor="middle" className={nCls} stroke="none">
              n={b.n}
            </text>
          </g>
        );
      })}
      <text x={left - 40} y={top + 2} className={tickCls} stroke="none">solve</text>
    </svg>
  );
}


// ── Fig 2: the pedal netlist as stage 0 sees it ────────

const CLUSTER_NODES = [
  { label: "Tone1", x: 178, y: 97 },
  { label: "Volume1", x: 158, y: 154 },
  { label: "D1", x: 97, y: 154 },
  { label: "D2", x: 79, y: 95 },
  { label: "C5", x: 129, y: 60 },
  { label: "R5", x: 192, y: 323 },
  { label: "R6", x: 129, y: 325 },
  { label: "C2", x: 159, y: 270 },
  { label: "Boost1", x: 546, y: 124 },
  { label: "C3", x: 484, y: 120 },
  { label: "R1", x: 519, y: 68 },
  { label: "C4", x: 365, y: 205 },
  { label: "R3", x: 313, y: 239 },
  { label: "Q1", x: 279, y: 187 },
  { label: "Gain1", x: 331, y: 153 },
  { label: "R2", x: 528, y: 312 },
  { label: "C1", x: 471, y: 337 },
  { label: "R4", x: 477, y: 275 },
];
// [x1, y1, x2, y2, weight]
const CLUSTER_EDGES: [number, number, number, number, number][] = [
  [178,97,97,154,0.33],
  [178,97,484,120,0.33],
  [178,97,79,95,0.33],
  [178,97,158,154,1],
  [178,97,129,60,1],
  [192,323,471,337,0.13],
  [192,323,129,325,0.13],
  [192,323,365,205,0.13],
  [192,323,129,60,0.13],
  [192,323,97,154,0.13],
  [192,323,313,239,0.13],
  [192,323,79,95,0.13],
  [192,323,158,154,0.13],
  [192,323,279,187,0.33],
  [192,323,477,275,0.33],
  [192,323,159,270,0.33],
  [158,154,471,337,0.13],
  [158,154,129,325,0.13],
  [158,154,365,205,0.13],
  [158,154,129,60,0.13],
  [158,154,97,154,0.13],
  [158,154,313,239,0.13],
  [158,154,79,95,0.13],
  [546,124,519,68,0.83],
  [546,124,528,312,0.5],
  [546,124,279,187,0.33],
  [546,124,484,120,0.33],
  [97,154,484,120,0.33],
  [97,154,79,95,0.46],
  [97,154,471,337,0.13],
  [97,154,129,325,0.13],
  [97,154,365,205,0.13],
  [97,154,129,60,0.13],
  [97,154,313,239,0.13],
  [365,205,471,337,0.13],
  [365,205,129,325,0.13],
  [365,205,129,60,0.13],
  [365,205,313,239,0.13],
  [365,205,79,95,0.13],
  [365,205,331,153,1],
  [129,325,471,337,0.13],
  [129,325,129,60,0.13],
  [129,325,313,239,0.13],
  [129,325,79,95,0.13],
  [129,325,159,270,1],
  [484,120,79,95,0.33],
  [484,120,279,187,0.33],
  [484,120,519,68,0.33],
  [528,312,477,275,0.5],
  [528,312,471,337,0.5],
  [528,312,519,68,0.5],
  [313,239,471,337,0.13],
  [313,239,129,60,0.13],
  [313,239,79,95,0.13],
  [313,239,331,153,0.5],
  [313,239,279,187,0.5],
  [79,95,471,337,0.13],
  [79,95,129,60,0.13],
  [129,60,471,337,0.13],
  [471,337,477,275,0.5],
  [279,187,519,68,0.33],
  [279,187,477,275,0.33],
  [279,187,159,270,0.33],
  [279,187,331,153,0.5],
  [477,275,159,270,0.33],
];
// hull colors match the tile borders of Figure 4 and the boxes of Figure 5
const CLUSTER_HULLS = [
  { cx: 128, cy: 112, r: 74, color: "#f59e0b" },
  { cx: 160, cy: 306, r: 58, color: "#a3e635" },
  { cx: 516, cy: 104, r: 58, color: "#e879f9" },
  { cx: 322, cy: 196, r: 66, color: "#22d3ee" },
  { cx: 492, cy: 308, r: 58, color: "#f43f5e" },
];

/** The component graph of the guitar-pedal netlist under equation (7),
 * with the clusters stage 0 returns. Coordinates are precomputed; edge
 * width and opacity scale with pair weight. */
export function FigClusters() {
  const nodeCls = "fill-[var(--copper)]";
  const labelCls = "fill-neutral-700 dark:fill-neutral-300 font-mono text-[9.5px]";
  const edgeCls = "stroke-neutral-500 dark:stroke-neutral-400";
  return (
    <svg viewBox="0 0 640 400" role="img" aria-label="Component graph with weighted edges and the five clusters" className="w-full h-auto">
      {CLUSTER_EDGES.map(([x1, y1, x2, y2, w], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={edgeCls}
          strokeWidth={0.5 + w * 2.4} opacity={w < 0.2 ? 0.18 : 0.35 + w * 0.5} />
      ))}
      {CLUSTER_HULLS.map((h, i) => (
        <circle key={i} cx={h.cx} cy={h.cy} r={h.r} fill="none" stroke={h.color} strokeWidth={1.5} strokeDasharray="4 4" />
      ))}
      {CLUSTER_NODES.map((n) => (
        <g key={n.label}>
          <circle cx={n.x} cy={n.y} r={4} className={nodeCls} />
          <text x={n.x} y={n.y + 14} textAnchor="middle" className={labelCls}>{n.label}</text>
        </g>
      ))}
    </svg>
  );
}
