"use client";

import type { LabArrow, LabBoard, LabWire } from "@/components/stripboard/autoLayout5";
import { StaticPart } from "@/components/stripboard/partDrawing";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { DEFAULT_COMPONENTS } from "@/data/defaultComponents";
import { PARTS, netColor } from "./lab";

// ── A board drawn the way the editor draws it ──
// Copper strips per segment, holes, the parts as their real packages,
// net-coloured pins, red X cuts, link wires. Plus the overlays the
// decode figures need: bus-row bands, a reading cursor, hole marks,
// constraint arrows between components, highlighted components and nets.

// a real package may hang almost a hole over the outermost line, so the
// margins leave it that room
const SP = 26, HOLE_R = 3.9, STRIP_H = 5, PAD = SP * 0.4, LEFT = 46, TOP = 40, EDGE = 28;

// arrowhead at (x, y) pointing away from the curve's control point
function Head({ x, y, fromX, fromY, color }: { x: number; y: number; fromX: number; fromY: number; color: string }) {
  const dx = x - fromX, dy = y - fromY, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const s = 6;
  return <polygon points={`${x},${y} ${x - ux * s - uy * s * 0.5},${y - uy * s + ux * s * 0.5} ${x - ux * s + uy * s * 0.5},${y - uy * s - ux * s * 0.5}`} fill={color} />;
}

// overlapping vertical wires on one column get small sideways lane shifts,
// as in the editor, so both stay visible
function laneShifts(wires: LabWire[]): number[] {
  const out = wires.map(() => 0);
  const byCol = new Map<number, { i: number; lo: number; hi: number }[]>();
  wires.forEach((w, i) => {
    if (w.c1 !== w.c2) return;
    if (!byCol.has(w.c1)) byCol.set(w.c1, []);
    byCol.get(w.c1)!.push({ i, lo: Math.min(w.r1, w.r2), hi: Math.max(w.r1, w.r2) });
  });
  for (const group of byCol.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const ends: number[] = [];
    for (const g of group) {
      let lane = ends.findIndex((e) => e <= g.lo);
      if (lane === -1) { lane = ends.length; ends.push(g.hi); } else ends[lane] = g.hi;
      out[g.i] = lane === 0 ? 0 : Math.ceil(lane / 2) * 4 * (lane % 2 === 1 ? 1 : -1);
    }
  }
  return out;
}

// `rows`/`cols` ask for a canvas at least that large, so a series of boards
// keeps one size; the board's own grid is never cut off. With `fixed` the
// canvas is exactly that size and a larger board runs past its edge.
export default function BoardView({ state, rows, cols, labels = true, fixed = false }: { state: LabBoard; rows?: number; cols?: number; labels?: boolean; fixed?: boolean }) {
  const R = fixed ? rows ?? state.rows : Math.max(rows ?? 0, state.rows);
  const C = fixed ? cols ?? state.cols : Math.max(cols ?? 0, state.cols);
  const left = labels ? LEFT : EDGE, top = labels ? TOP : EDGE;
  const W = left + (C - 1) * SP + EDGE, H = top + (R - 1) * SP + EDGE;
  const cx = (c: number) => left + c * SP;
  const cy = (r: number) => top + r * SP;
  const dimNet = (n: number) => state.hlNet !== undefined && n !== state.hlNet;
  const cutAt = (r: number, c: number) => state.cuts.find((k) => k.row === r && k.kind === "hole" && k.col === c);
  const hlSet = new Set(state.hl ?? []);
  // whatever the current step touches is drawn last, so it is never hidden
  const rank = (s: string) => (s === "push" ? 3 : s === "conflict" ? 2 : s === "ok" ? 1 : 0);
  const byRank = <T,>(xs: T[], of: (x: T) => number) => xs.map((x, i) => [x, i] as const).sort((a, b) => of(a[0]) - of(b[0]));
  const shifts = laneShifts(state.wires);

  const arrowEl = ([a, i]: readonly [LabArrow, number]) => {
    const pa = state.parts.find((p) => p.pi === a.a), pb = state.parts.find((p) => p.pi === a.b);
    if (!pa || !pb) return null;
    const x1 = cx(pa.x + pa.w - 1) + PAD, y1 = cy(pa.y) + ((pa.h - 1) * SP) / 2;
    const x2 = cx(pb.x) - PAD, y2 = cy(pb.y) + ((pb.h - 1) * SP) / 2;
    const color = a.state === "push" ? "#f59e0b" : a.state === "ok" ? "#16a34a" : a.state === "conflict" ? "#dc2626" : "#9ca3af";
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 10;
    return (
      <g key={`a${i}`} opacity={a.state === "idle" ? 0.6 : 1}>
        <path d={`M${x1},${y1} Q${mx},${my - 14} ${x2},${y2}`} fill="none" stroke="var(--board-fill)" strokeWidth={(a.state === "push" ? 2.2 : 1.4) + 3} strokeOpacity={0.85} />
        <path d={`M${x1},${y1} Q${mx},${my - 14} ${x2},${y2}`} fill="none" stroke={color} strokeWidth={a.state === "push" ? 2.2 : 1.4} />
        <Head x={x2} y={y2} fromX={mx} fromY={my - 14} color={color} />
        <text x={mx} y={my - 10} textAnchor="middle" fontSize={9} fill={color} fontWeight={600} stroke="var(--board-fill)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{a.w}</text>
      </g>
    );
  };

  // arrows the step is not about go under the components, the current one on top
  const sorted = byRank(state.arrows ?? [], (a) => rank(a.state));
  const idleArrows = sorted.filter(([a]) => rank(a.state) === 0);
  const liveArrows = sorted.filter(([a]) => rank(a.state) > 0);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full h-auto rounded bg-[var(--board-fill)] border border-neutral-200 dark:border-neutral-700 font-sans">
      {state.busRows.map((r) => (
        <rect key={`b${r}`} x={cx(0) - SP * 0.5} y={cy(r) - SP * 0.45} width={(C - 1) * SP + SP} height={SP * 0.9} rx={4} fill="#3b82f6" fillOpacity={0.08} />
      ))}
      {state.segs.map((s, i) => {
        if (s.row >= R) return null;
        const leftX = s.c1 > 0 && cutAt(s.row, s.c1 - 1) ? cx(s.c1 - 1) + HOLE_R + 1.5 : cx(s.c1) - SP * 0.4;
        const rightX = s.c2 < C - 1 && cutAt(s.row, s.c2 + 1) ? cx(s.c2 + 1) - HOLE_R - 1.5 : cx(s.c2) + SP * 0.4;
        const hasNet = s.net >= 0 && netColor(s.net) !== "#D4A853";
        return <rect key={i} x={leftX} y={cy(s.row) - STRIP_H / 2} width={Math.max(0, rightX - leftX)} height={STRIP_H} rx={1} fill={netColor(s.net)} opacity={hasNet ? (dimNet(s.net) ? 0.2 : 0.55) : 0.4} />;
      })}
      {state.cuts.filter((k) => k.kind === "knife").map((k, i) => (
        <rect key={`kn${i}`} x={cx(k.col) + SP / 2 - 2} y={cy(k.row) - STRIP_H / 2 - 1} width={4} height={STRIP_H + 2} fill="var(--board-fill)" />
      ))}
      {labels && Array.from({ length: R }, (_, r) => <text key={`r${r}`} x={cx(0) - 30} y={cy(r) + 4} textAnchor="end" fontSize={10} fill="var(--label-text)">{r + 1}</text>)}
      {labels && Array.from({ length: C }, (_, c) => <text key={`c${c}`} x={cx(c)} y={cy(0) - 26} textAnchor="middle" fontSize={10} fill="var(--label-text)">{c + 1}</text>)}
      {Array.from({ length: R * C }, (_, i) => {
        const r = Math.floor(i / C), c = i % C;
        return <circle key={i} cx={cx(c)} cy={cy(r)} r={HOLE_R} fill="var(--hole-fill)" stroke="var(--hole-stroke)" strokeWidth={0.5} />;
      })}
      {idleArrows.map(arrowEl)}
      {byRank(state.parts, (p) => (hlSet.has(p.pi) ? 1 : 0)).map(([p]) => {
        const hl = hlSet.has(p.pi);
        const comp = { ...PARTS[p.pi].comp, boardPos: p.pos, rotation: p.rot, flexibleEndPos: p.end };
        const def = resolveComponentDef(comp, DEFAULT_COMPONENTS);
        if (!def) return null;
        return (
          <g key={p.pi} opacity={state.ghost && !hl ? 0.55 : 1}>
            <StaticPart
              def={def}
              component={comp}
              at={(r, c) => ({ x: cx(c), y: cy(r) })}
              pitch={SP}
              pinNames="all"
              label={PARTS[p.pi].id}
              outline={hl ? "#f59e0b" : undefined}
              outlineWidth={hl ? 0.3 : undefined}
              strokeWidth={hl ? 2 : 1}
              pinStyle={(pin) => {
                const net = p.pins.find((q) => q.id === pin.pinId)?.net ?? -1;
                return { color: net >= 0 ? netColor(net) : null, opacity: net >= 0 && dimNet(net) ? 0.35 : 1 };
              }}
            />
          </g>
        );
      })}
      {state.cuts.map((k, i) => {
        const x = k.kind === "hole" ? cx(k.col) : cx(k.col) + SP / 2;
        const y = cy(k.row);
        return (
          <g key={i} stroke="var(--cut-stroke)" strokeWidth={1.8} strokeLinecap="round">
            <line x1={x - 3.5} y1={y - 3.5} x2={x + 3.5} y2={y + 3.5} />
            <line x1={x + 3.5} y1={y - 3.5} x2={x - 3.5} y2={y + 3.5} />
          </g>
        );
      })}
      {state.wires.map((w, i) => (
        <g key={i} opacity={dimNet(w.net) ? 0.3 : 1}>
          <line x1={cx(w.c1) + shifts[i]} y1={cy(w.r1)} x2={cx(w.c2) + shifts[i]} y2={cy(w.r2)} stroke={netColor(w.net)} strokeWidth={2} strokeLinecap="round" opacity={0.85} strokeDasharray={w.slanted ? "5 3" : undefined} />
          <circle cx={cx(w.c1) + shifts[i]} cy={cy(w.r1)} r={4} fill={netColor(w.net)} />
          <circle cx={cx(w.c2) + shifts[i]} cy={cy(w.r2)} r={4} fill={netColor(w.net)} />
        </g>
      ))}
      {state.marks?.map((m, i) => (
        <circle key={`m${i}`} cx={cx(m.c)} cy={cy(m.r)} r={6.5} fill="none" stroke={m.kind === "ok" ? "#16a34a" : "#dc2626"} strokeWidth={1.8} />
      ))}
      {liveArrows.map(arrowEl)}
      {state.cursor && (
        <g>
          <rect x={cx(0) - SP * 0.5} y={cy(state.cursor.r) - SP * 0.45} width={(C - 1) * SP + SP} height={SP * 0.9} rx={4} fill="none" stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="3 3" />
          <circle cx={cx(state.cursor.c)} cy={cy(state.cursor.r)} r={8} fill="none" stroke="#f59e0b" strokeWidth={2} />
        </g>
      )}
    </svg>
  );
}
