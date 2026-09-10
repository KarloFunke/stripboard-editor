"use client";

import type { LabArrow, LabLanes, LabTie } from "@/components/stripboard/autoLayout5";
import { PARTS, netColor } from "./lab";

// ── The row stage as lanes ──
// One lane per component in first-order sequence, the vertical axis is the row.
// Components hang in their lane at their current row; arrows say "at least this
// many rows below"; dashed ties join pins that must share a strip. An
// upright flexible component has a top and a bottom node and stretches between.

const SP = 22, LANE = 64, LEFT = 30, TOP = 22, BOX_W = 30;
// halo stroke in the figure's background colour, so arrows and labels stay
// readable where they cross a component
const HALO = "dark:[stroke:#1e1e1e]";

function Head({ x, y, fromX, fromY, color }: { x: number; y: number; fromX: number; fromY: number; color: string }) {
  const dx = x - fromX, dy = y - fromY, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const s = 6;
  return <polygon points={`${x},${y} ${x - ux * s - uy * s * 0.5},${y - uy * s + ux * s * 0.5} ${x - ux * s + uy * s * 0.5},${y - uy * s - ux * s * 0.5}`} fill={color} />;
}

export default function LaneView({ lanes, rows }: { lanes: LabLanes; rows: number }) {
  const n = lanes.order.length;
  const W = LEFT + n * LANE + 10, H = TOP + rows * SP + 10;
  const laneX = new Map(lanes.order.map((pi, i) => [pi, LEFT + i * LANE + LANE / 2]));
  const cy = (r: number) => TOP + r * SP;
  const partOfNode = new Map<number, number>();
  for (const g of lanes.geo) { partOfNode.set(g.top, g.pi); partOfNode.set(g.bot, g.pi); }
  const geoOf = (pi: number) => lanes.geo.find((g) => g.pi === pi)!;
  const topRow = (pi: number) => lanes.nodeY[geoOf(pi).top];
  const botRow = (pi: number) => { const g = geoOf(pi); return g.bot !== g.top ? lanes.nodeY[g.bot] : lanes.nodeY[g.top] + g.h - 1; };
  const hl = new Set(lanes.hl ?? []);
  const color = (s: string) => (s === "push" || s === "check" ? "#f59e0b" : s === "ok" ? "#16a34a" : s === "conflict" || s === "split" ? "#dc2626" : "#9ca3af");
  // whatever the current step touches is drawn last, so it is never hidden
  const rank = (s: string) => (s === "push" ? 3 : s === "check" || s === "conflict" || s === "split" ? 2 : s === "ok" ? 1 : 0);
  const byRank = <T,>(xs: T[], of: (x: T) => number) => xs.map((x, i) => [x, i] as const).sort((a, b) => of(a[0]) - of(b[0]));
  const side = (g: LabLanes["geo"][number], dc: number) => (dc > 0 ? 7 : g.pins.some((q) => q.dc > 0) ? -7 : 0);
  const pinAt = (node: number, off: number) => {
    const pi = partOfNode.get(node)!;
    const g = geoOf(pi);
    const pin = g.pins.find((q) => q.node === node && q.off === off);
    return { x: laneX.get(pi)! + (pin ? side(g, pin.dc) : 0), y: cy(lanes.nodeY[node] + off) };
  };

  const arrowEl = ([a, i]: readonly [LabArrow, number]) => {
    const pa = partOfNode.get(a.a), pb = partOfNode.get(a.b);
    if (pa === undefined || pb === undefined) return null;
    const x1 = laneX.get(pa)!, y1 = cy(pa === pb ? lanes.nodeY[a.a] : botRow(pa)) + 6;
    const x2 = laneX.get(pb)!, y2 = cy(lanes.nodeY[a.b]) - 8;
    const c = color(a.state);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const bend = x1 === x2 ? 0 : (x2 > x1 ? -1 : 1) * 14;
    return (
      <g key={`a${i}`} opacity={a.state === "idle" ? 0.6 : 1}>
        <path d={`M${x1},${y1} Q${mx},${my + bend} ${x2},${y2}`} fill="none" stroke="#fff" className={HALO} strokeWidth={(a.state === "push" ? 2.2 : 1.3) + 3} strokeOpacity={0.85} />
        <path d={`M${x1},${y1} Q${mx},${my + bend} ${x2},${y2}`} fill="none" stroke={c} strokeWidth={a.state === "push" ? 2.2 : 1.3} />
        <Head x={x2} y={y2} fromX={mx} fromY={my + bend} color={c} />
        <text x={mx + (bend ? bend * 0.9 : 8)} y={my + 3 + bend * 0.5} textAnchor="middle" fontSize={9} fill={c} fontWeight={600} stroke="#fff" className={HALO} strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{`≥${a.w}`}</text>
      </g>
    );
  };
  const tieEl = ([t, i]: readonly [LabTie, number]) => {
    const a = pinAt(t.u, t.offU), b = pinAt(t.v, t.offV);
    const gu = geoOf(partOfNode.get(t.u)!);
    const pin = gu.pins.find((q) => q.node === t.u && q.off === t.offU);
    const c = t.state === "idle" ? (pin && pin.net >= 0 ? netColor(pin.net) : "#9ca3af") : color(t.state);
    return <line key={`t${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={t.state === "idle" ? 1.2 : 2.2} strokeDasharray={t.state === "split" ? "2 4" : "5 3"} opacity={t.state === "idle" ? 0.6 : 1} />;
  };

  // what the step is not about goes under the components, the current one on top
  const arrows = byRank(lanes.arrows, (a) => rank(a.state));
  const idleArrows = arrows.filter(([a]) => rank(a.state) === 0);
  const liveArrows = arrows.filter(([a]) => rank(a.state) > 0);
  const ties = byRank(lanes.ties, (t) => rank(t.state));
  const idleTies = ties.filter(([t]) => rank(t.state) === 0);
  const liveTies = ties.filter(([t]) => rank(t.state) > 0);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-white dark:bg-[#1e1e1e] border border-neutral-200 dark:border-neutral-700 font-sans">
      {Array.from({ length: rows }, (_, r) => (
        <g key={r}>
          <line x1={LEFT} y1={cy(r)} x2={W - 6} y2={cy(r)} stroke="currentColor" strokeOpacity={0.08} />
          <text x={LEFT - 6} y={cy(r) + 3.5} textAnchor="end" fontSize={9} fill="var(--label-text)">{r + 1}</text>
        </g>
      ))}
      {idleTies.map(tieEl)}
      {idleArrows.map(arrowEl)}
      {byRank(lanes.order, (pi) => (hl.has(pi) ? 1 : 0)).map(([pi]) => {
        const g = geoOf(pi);
        const x = laneX.get(pi)!, y0 = cy(Math.min(topRow(pi), botRow(pi))), y1 = cy(Math.max(topRow(pi), botRow(pi)));
        const isHl = hl.has(pi);
        return (
          <g key={pi}>
            <rect x={x - BOX_W / 2} y={y0 - 8} width={BOX_W} height={y1 - y0 + 16} rx={3} fill="var(--component-fill)" stroke={isHl ? "#f59e0b" : "var(--component-stroke)"} strokeWidth={isHl ? 2 : 1} strokeDasharray="4 3" />
            <text x={x} y={y0 - 11} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--component-text)">{PARTS[pi].id}</text>
            {g.pins.map((p, k) => (
              <circle key={k} cx={x + side(g, p.dc)} cy={cy(lanes.nodeY[p.node] + p.off)} r={3.6} fill={p.net >= 0 ? netColor(p.net) : "var(--hole-fill)"} stroke="var(--hole-fill)" strokeWidth={1} />
            ))}
          </g>
        );
      })}
      {liveTies.map(tieEl)}
      {liveArrows.map(arrowEl)}
    </svg>
  );
}
