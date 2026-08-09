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
