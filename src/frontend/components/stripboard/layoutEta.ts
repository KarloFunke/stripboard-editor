import type { AutoLayoutProgress } from "./layoutTypes";

// ── Time left in a v5 run, from its seeds' progress reports ──
// A seed reports the share m of its anneal moves done. Early moves are
// slower (hot, messy boards decode slower), so time does not grow in step
// with m: the share of a seed's anneal time spent by move share m is
// m^0.873, whatever the board size (fitted 2026-09-26 on 80 corpus
// projects; the seed's predicted total is then within ±7 % half the time
// at 10-30 % of the walk and ±2 % from 60 % on, with no drift). A seed's
// total is its time so far over that share, and the run ends with its last
// seed. The finish after the anneal takes a tenth of a second or so. With
// more seeds than workers the seeds run in waves: a seed still waiting starts
// when the first worker frees up and takes as long as the seeds clocked so far.
const TIME_EXP = 0.873;
const FINISH_MS = 100;
// below this move share a seed's own clock says too little yet
const MIN_SHARE = 0.03;

interface SeedState { t0: number; m: number; t: number; finishing: boolean; done: boolean; end?: number }

export class RunEta {
  private seeds = new Map<number, SeedState>();
  private end: number | undefined;
  private viewedAt = 0;
  private shown = 0;

  // seeds: how many the run has; priorS: this circuit's last run time at
  // this effort, if one was measured; annealTop: the fraction a seed reports
  // when its anneal is done (a stacked solve reports its leaves up to 0.9);
  // workers: how many seeds run at once
  constructor(private start: number, private nSeeds: number, private priorS?: number, private annealTop = 1, private workers = nSeeds) {}

  report(seed: number, p: AutoLayoutProgress, now: number): void {
    let s = this.seeds.get(seed);
    if (!s) this.seeds.set(seed, (s = { t0: now, m: 0, t: now, finishing: false, done: false }));
    // a finish report at the top of the range ends the anneal; one below it
    // is a stacked leaf's own finish, part of the walk
    if (p.phase !== "arrange" && p.frac >= this.annealTop) s.finishing = true;
    else {
      const m = Math.min(1, p.frac / this.annealTop);
      if (s.finishing || m < s.m) return;
      s.m = m;
      s.t = now;
    }
  }

  done(seed: number, now: number): void {
    const s = this.seeds.get(seed);
    if (s) { s.done = true; s.end = now; }
    else this.seeds.set(seed, { t0: this.start, m: 1, t: this.start, finishing: true, done: true, end: now });
  }

  /** The bar's fill (never going back) and the seconds left, once known. */
  view(now: number): { frac: number; left?: number } {
    let raw: number | undefined;
    let moveShare = 0;
    for (const s of this.seeds.values()) moveShare += s.done || s.finishing ? 1 : s.m;
    moveShare /= Math.max(1, this.nSeeds);
    const running = [...this.seeds.values()].filter((s) => !s.done);
    const waiting = Math.max(0, this.nSeeds - this.seeds.size);
    // a seed's end by its own clock, once that says enough
    const own = (s: SeedState) => (s.finishing ? now + FINISH_MS : s.m >= MIN_SHARE ? s.t0 + (s.t - s.t0) / Math.pow(s.m, TIME_EXP) + FINISH_MS : undefined);
    let total = 0, n = 0;
    for (const s of this.seeds.values()) {
      const e = s.done ? s.end : own(s);
      if (e !== undefined) { total += e - s.t0; n++; }
    }
    // the first wave clocks the run; after a seed is done, one that has just
    // started takes as long as the seeds so far
    const anyDone = running.length < this.seeds.size;
    const clocked = this.seeds.size >= Math.min(this.workers, this.nSeeds) && (anyDone ? n > 0 : running.every((s) => own(s) !== undefined));
    if (clocked && (running.length > 0 || waiting > 0)) {
      const each = total / n;
      const free = running.map((s) => own(s) ?? s.t0 + each);
      while (free.length < this.workers) free.push(now);
      for (let i = 0; i < waiting; i++) {
        free.sort((a, b) => a - b);
        free[0] = Math.max(free[0], now) + each;
      }
      raw = Math.max(...free);
    } else if (this.priorS !== undefined) raw = this.start + this.priorS * 1000;
    if (raw !== undefined) {
      // a new estimate is eased in over about a second, however often the
      // run is viewed, so the countdown and the bar do not jump
      const k = 1 - Math.exp(-Math.max(0, now - this.viewedAt) / 1000);
      this.end = this.end === undefined ? raw : this.end + k * (raw - this.end);
    }
    this.viewedAt = now;
    const left = this.end === undefined ? undefined : Math.max(0, this.end - now);
    const elapsed = now - this.start;
    const f = left === undefined ? moveShare : elapsed / (elapsed + left);
    this.shown = Math.max(this.shown, Math.min(1, f));
    return { frac: this.shown, ...(left !== undefined ? { left: left / 1000 } : {}) };
  }
}

/** "42 s left", "3 min 5 s left" */
export function leftText(s: number): string {
  const n = Math.ceil(s);
  if (n <= 0) return "Almost done";
  return n < 60 ? `${n} s left` : `${Math.floor(n / 60)} min ${n % 60} s left`;
}
