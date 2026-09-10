"use client";

import { LAB, GENOME, PARTS, NETS } from "./lab";
import GenomeView from "./GenomeView";

// ── Section 4: the example circuit and its complete description ──

const KIND: Record<string, string> = { U1: "555 timer, 8-pin DIP", Q1: "NPN transistor", J1: "3-pin connector", C1: "capacitor", R1: "resistor", R2: "resistor" };

export default function ExampleGenome() {
  return (
    <figure className="my-6 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/40 p-3 sm:p-4 text-xs text-neutral-700 dark:text-neutral-300">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 mb-3">
        <div>
          <p className="font-mono text-neutral-500 dark:text-neutral-400 mb-1">components</p>
          {PARTS.map((p) => <div key={p.id}><span className="font-mono">{p.id}</span> {KIND[p.id] ?? p.kind}{p.kind === "flex" ? `, leads span ${p.spans[0] === p.spans[1] ? p.spans[0] : `${p.spans[0]} to ${p.spans[1]}`} holes` : ""}</div>)}
        </div>
        <div>
          <p className="font-mono text-neutral-500 dark:text-neutral-400 mb-1">nets</p>
          {NETS.map((n) => (
            <div key={n.name}><span className="inline-block w-2.5 h-2.5 rounded-full mr-1 align-middle" style={{ background: n.color }} /><span className="font-mono">{n.name}</span> {n.pins.map((q) => `${PARTS[q.pi].id}.${q.name}`).join(", ")}</div>
          ))}
        </div>
      </div>
      <p className="font-mono text-neutral-500 dark:text-neutral-400 mb-1">description</p>
      <GenomeView g={LAB.cloneG(GENOME)} />
      <figcaption className="mt-3 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">
        The whole state of the example, as the layouter holds it. Pin names follow the component: U1.OUT is the timer&apos;s output
        pin, C1.2 the second leg of the capacitor.
      </figcaption>
    </figure>
  );
}
