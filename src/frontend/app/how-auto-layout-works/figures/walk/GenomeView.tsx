"use client";

import type { LabGenome } from "@/components/stripboard/autoLayout5";
import { LAB, PARTS, NETS } from "./lab";

// ── The description as a reader can read it ──
// Entries that differ from `prev` are marked, so a move shows what it changed.

export default function GenomeView({ g, prev }: { g: LabGenome; prev?: LabGenome }) {
  const changed = (a: unknown, b: unknown) => prev !== undefined && JSON.stringify(a) !== JSON.stringify(b);
  const hot = "text-amber-600 dark:text-amber-400 font-semibold";
  const item = (on: boolean) => `inline-block px-1.5 py-0.5 rounded border ${on ? "border-amber-500 " + hot : "border-neutral-200 dark:border-neutral-700"}`;
  const chips = (o: number[], po?: number[]) => (
    <span className="inline-flex gap-1.5 flex-wrap">
      {o.map((pi, i) => <span key={pi} className={`px-2 py-0.5 rounded border font-mono ${po && po[i] !== pi ? "border-amber-500 " + hot : "border-neutral-300 dark:border-neutral-600"}`}>{PARTS[pi].id}</span>)}
    </span>
  );
  const rigid = LAB.rigidIdx.map((pi, k) => (
    <span key={pi} className={item(changed(g.rot[k], prev?.rot[k]))}><span className="font-mono">{PARTS[pi].id}</span> {g.rot[k] ? `turned ${g.rot[k] * 90}°` : "upright"}</span>
  ));
  const flex = LAB.flexIdx.map((pi, k) => {
    const p = PARTS[pi];
    const flat = g.hv[k] === 1 && p.canH;
    return <span key={pi} className={item(changed([g.hv[k], g.br[k]], prev ? [prev.hv[k], prev.br[k]] : undefined))}><span className="font-mono">{p.id}</span> {flat ? "flat" : "upright"}{g.br[k] ? ", turned around" : ""}</span>;
  });
  const groups = NETS.map((n, ni) => {
    const ids = [...new Set(g.grp[ni])];
    const sets = ids.map((gid) => n.pins.filter((_, i) => g.grp[ni][i] === gid).map((q) => `${PARTS[q.pi].id}.${q.name}`).join("  "));
    return (
      <span key={ni} className={`inline-flex items-center gap-1.5 flex-wrap ${changed(g.grp[ni], prev?.grp[ni]) ? hot : ""}`}>
        <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: n.color }} />
        <span className="font-mono">{n.name}</span>
        {sets.map((s, i) => <span key={i} className="px-1.5 rounded border border-neutral-200 dark:border-neutral-700 font-mono">{s}</span>)}
      </span>
    );
  });
  const gaps = PARTS.flatMap((p, pi) => [
    g.gap[pi] ? { pi, key: "r", text: `${g.gap[pi]} row${g.gap[pi] > 1 ? "s" : ""} below ${p.id}`, on: changed(g.gap[pi], prev?.gap[pi]) } : null,
    g.xgap[pi] ? { pi, key: "c", text: `${g.xgap[pi]} column${g.xgap[pi] > 1 ? "s" : ""} right of ${p.id}`, on: changed(g.xgap[pi], prev?.xgap[pi]) } : null,
  ]).filter((x): x is NonNullable<typeof x> => x !== null);
  const released = prev ? PARTS.flatMap((p, pi) => [prev.gap[pi] && !g.gap[pi] ? `rows below ${p.id}` : null, prev.xgap[pi] && !g.xgap[pi] ? `columns right of ${p.id}` : null]).filter(Boolean) : [];
  const label = "font-mono text-neutral-500 dark:text-neutral-400 shrink-0 w-28 pt-0.5";
  return (
    <div className="text-xs text-neutral-700 dark:text-neutral-300 flex flex-col gap-2.5">
      <div className="flex items-start gap-3"><span className={label}>first order</span>{chips(g.gp, prev?.gp)}</div>
      <div className="flex items-start gap-3"><span className={label}>second order</span>{chips(g.gn, prev?.gn)}</div>
      <div className="flex items-start gap-3"><span className={label}>orientation</span><span className="inline-flex gap-1.5 flex-wrap">{rigid}{flex}</span></div>
      <div className="flex items-start gap-3"><span className={label}>strip groups</span><span className="flex min-w-0 gap-x-4 gap-y-1.5 flex-wrap">{groups}</span></div>
      <div className="flex items-start gap-3">
        <span className={label}>blank lines</span>
        <span className="inline-flex gap-1.5 flex-wrap">
          {gaps.length ? gaps.map((x) => <span key={`${x.pi}${x.key}`} className={item(x.on)}>{x.text}</span>) : <span className="pt-0.5">none reserved</span>}
          {released.map((t) => <span key={t} className={`${item(true)} line-through`}>{t}</span>)}
        </span>
      </div>
    </div>
  );
}
