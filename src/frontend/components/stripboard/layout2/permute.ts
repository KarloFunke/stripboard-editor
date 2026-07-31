import { Component, Net, NetAssignment } from "@/types";

/** Deterministic RNG (same generator as the v1 annealer's). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SolveInputs {
  components: Component[];
  nets: Net[];
  netAssignments: NetAssignment[];
}

/**
 * Ordering i of the solver inputs. Ordering 0 is the identity (the caller's
 * own array order); higher indices shuffle components, nets and assignments
 * with a seed fixed per index, so the same project at the same i always
 * yields the same ordering. The netlist itself is unchanged — only the
 * solver's order-based tie-breaks see a difference.
 */
export function permutedInputs(inputs: SolveInputs, i: number): SolveInputs {
  if (i === 0) return inputs;
  const rand = mulberry32(0x9e3779b9 ^ Math.imul(i, 0x85ebca6b));
  const shuffled = <T,>(arr: readonly T[]): T[] => {
    const a = [...arr];
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  };
  return {
    components: shuffled(inputs.components),
    nets: shuffled(inputs.nets),
    netAssignments: shuffled(inputs.netAssignments),
  };
}
