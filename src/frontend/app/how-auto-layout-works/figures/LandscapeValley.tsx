"use client";

import { useEffect, useRef } from "react";

// ── Section 2: the landscape most real problems offer at best ──
// A sketch: a seeded terrain drains into channels, most directions from any
// point are walls, and between the walls the floor keeps falling. The
// channels form separate trees; some end in closed basins, none is promised
// to reach the lowest point. Drawn once, from above.

const N = 192, M = 192;
const MV = 152;          // rows drawn: the view looks down on a strip of the terrain
const FILL_CAP = 0.22;   // pits shallower than this are filled, deeper ones stay basins
const CHANNEL_MIN = 90;  // drained cells a cell needs to count as a channel

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// value noise on a lattice, three octaves
function noiseField(rng: () => number, base: number): Float32Array {
  const out = new Float32Array(N * M);
  let amp = 1, cell = base;
  for (let o = 0; o < 3; o++) {
    const gw = Math.ceil(N / cell) + 2, gh = Math.ceil(M / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let k = 0; k < g.length; k++) g[k] = rng() * 2 - 1;
    const sm = (t: number) => t * t * (3 - 2 * t);
    for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
      const fx = i / cell, fy = j / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
      const v = (x: number, y: number) => g[y * gw + x];
      out[j * N + i] += amp * ((v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty);
    }
    amp *= 0.5; cell /= 2;
  }
  return out;
}

interface Terrain { hard: Float32Array; mess: Float32Array; channel: Uint8Array; hardNorm: Float32Array }

function makeTerrain(seed: number): Terrain {
  const rng = mulberry32(seed);
  const n1 = noiseField(rng, 46), n2 = noiseField(rng, 18);
  const hard = new Float32Array(N * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
    const t = j / (M - 1), u = (2 * i) / (N - 1) - 1;
    // a gentle slope toward the viewer and slightly raised sides; the noise
    // decides where the valleys are
    hard[j * N + i] = 1.6 * (1 - t) + 1.15 * n1[j * N + i] + 0.35 * u * u * u * u;
  }
  // fill the shallow pits so that rivers run long, keep the deep ones as
  // closed basins: a priority flood from the edges with a cap on the raise
  {
    const seen = new Uint8Array(N * M);
    const heap: number[] = [];
    const push = (k: number) => { heap.push(k); let c = heap.length - 1; while (c > 0) { const q = (c - 1) >> 1; if (hard[heap[q]] <= hard[heap[c]]) break; [heap[q], heap[c]] = [heap[c], heap[q]]; c = q; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && hard[heap[l]] < hard[heap[m]]) m = l; if (r < heap.length && hard[heap[r]] < hard[heap[m]]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    for (let i = 0; i < N; i++) for (const j of [0, M - 1]) { seen[j * N + i] = 1; push(j * N + i); }
    for (let j = 1; j < M - 1; j++) for (const i of [0, N - 1]) { seen[j * N + i] = 1; push(j * N + i); }
    while (heap.length) {
      const k = pop(), i = k % N, j = (k - i) / N;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if ((!di && !dj) || x < 0 || x >= N || y < 0 || y >= M || seen[y * N + x]) continue;
        seen[y * N + x] = 1;
        const n = y * N + x;
        if (hard[n] < hard[k] + 0.005 && hard[k] - hard[n] < FILL_CAP) hard[n] = hard[k] + 0.005;
        push(n);
      }
    }
  }
  // D8 drainage: every cell drains to its lowest neighbour, or nowhere if it
  // is the bottom of a basin
  const down = new Int32Array(N * M).fill(-1);
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
    let best = hard[j * N + i], bi = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const x = i + di, y = j + dj;
      if (x < 0 || x >= N || y < 0 || y >= M) continue;
      if (hard[y * N + x] < best) { best = hard[y * N + x]; bi = y * N + x; }
    }
    down[j * N + i] = bi;
  }
  const order = Array.from({ length: N * M }, (_, k) => k).sort((a, b) => hard[b] - hard[a]);
  const acc = new Float32Array(N * M).fill(1);
  for (const k of order) if (down[k] >= 0) acc[down[k]] += acc[k];
  let maxAcc = 1;
  for (let k = 0; k < acc.length; k++) if (acc[k] > maxAcc) maxAcc = acc[k];
  // carve: channel cells drop, the banks less, so the walls are steep
  const channel = new Uint8Array(N * M);
  const carve = new Float32Array(N * M);
  for (let k = 0; k < acc.length; k++) {
    if (acc[k] < CHANNEL_MIN) continue;
    channel[k] = 1;
    const d = 0.5 + 0.5 * Math.log(acc[k]) / Math.log(maxAcc);
    const i = k % N, j = (k - i) / N;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || x >= N || y < 0 || y >= M) continue;
      const r = Math.max(Math.abs(di), Math.abs(dj));
      carve[y * N + x] = Math.max(carve[y * N + x], d * (r === 0 ? 1 : r === 1 ? 0.55 : 0.2));
    }
  }
  for (let k = 0; k < hard.length; k++) hard[k] -= carve[k];
  // the channel floor falls along the drainage
  for (const k of order) {
    const dk = down[k];
    if (channel[k] && dk >= 0 && channel[dk] && hard[dk] > hard[k] - 0.01) hard[dk] = hard[k] - 0.01;
  }
  // secondary ridges as extra roughness, kept off the channels and banks
  const mess = new Float32Array(N * M);
  for (let k = 0; k < mess.length; k++) {
    if (carve[k] > 0) continue;
    mess[k] = Math.max(0, n2[k] - 0.05) * 1.2;
  }
  // one smoothing pass, so the facets do not show; the channel keeps its floor
  const sm = new Float32Array(N * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
    let sum = 0, wsum = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || x >= N || y < 0 || y >= M) continue;
      const w = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
      sum += w * (hard[y * N + x] + 0.6 * mess[y * N + x]); wsum += w;
    }
    sm[j * N + i] = sum / wsum;
  }
  for (let k = 0; k < hard.length; k++) hard[k] = channel[k] ? Math.min(sm[k], hard[k]) : sm[k];
  mess.fill(0);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < hard.length; k++) { if (hard[k] < lo) lo = hard[k]; if (hard[k] > hi) hi = hard[k]; }
  const hardNorm = new Float32Array(N * M);
  for (let k = 0; k < hard.length; k++) hardNorm[k] = (hard[k] - lo) / (hi - lo);
  return { hard, mess, channel, hardNorm };
}

// A low-poly ball: forty triangles around ten segments, flat shaded like the
// terrain around it. Drawn in the terrain's own painter order, so a hill in
// front of a ball still covers it.
const ICO = (() => {
  const SEG = 10, BANDS = 3;
  const at = (band: number, seg: number): [number, number, number] => {
    const phi = (band / BANDS) * Math.PI, th = ((seg % SEG) / SEG) * 2 * Math.PI;
    return [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
  };
  const faces: [number, number, number][][] = [];
  for (let b = 0; b < BANDS; b++) for (let sgm = 0; sgm < SEG; sgm++) {
    const a1 = at(b, sgm), a2 = at(b, sgm + 1), b1 = at(b + 1, sgm), b2 = at(b + 1, sgm + 1);
    if (b === 0) faces.push([a1, b1, b2]);
    else if (b === BANDS - 1) faces.push([a1, b1, a2]);
    else { faces.push([a1, b1, b2]); faces.push([a1, b2, a2]); }
  }
  const tri = faces.map(([A, B, C]) => {
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]] as const;
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]] as const;
    const n: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    const m = (A[0] + B[0] + C[0]) / 3 * n[0] + (A[1] + B[1] + C[1]) / 3 * n[1] + (A[2] + B[2] + C[2]) / 3 * n[2];
    const f = m < 0 ? -1 : 1; // outward normals whichever way the triangle was wound
    return { p: [A, B, C] as const, n: [(f * n[0]) / l, (f * n[1]) / l, (f * n[2]) / l] as const, z: (A[2] + B[2] + C[2]) / 3 };
  });
  tri.sort((x, y) => x.z - y.z);
  return tri;
})();

// Where independent runs end: each walker starts somewhere at random and
// anneals on the terrain with a falling temperature, exactly as a run does on
// the real landscape. It walks a terrain that also rises toward the rim, so
// it settles in the valleys the figure shows rather than draining off the
// edge, and a walker that lands on another's valley is sent out again.
function runEnds(hard: Float32Array, runs: number, seed: number): number[] {
  const INSET = 48;
  const field = new Float32Array(N * MV);
  for (let j = 0; j < MV; j++) for (let i = 0; i < N; i++) {
    const d = Math.min(i, N - 1 - i, j, MV - 1 - j);
    const t = Math.max(0, (INSET - d) / INSET);
    field[j * N + i] = hard[j * N + i] + 2.6 * t * t;
  }
  const rng = mulberry32(seed * 7919 + 17);
  const STEPS = 6000, T0 = 0.9, T1 = 0.002;
  const cl = (v: number, hi: number) => Math.max(2, Math.min(hi - 3, v));
  const out: number[] = [];
  for (let r = 0; r < runs; r++) {
    let k = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      let i = cl(Math.floor(rng() * N), N), j = cl(Math.floor(rng() * MV), MV);
      for (let step = 0; step < STEPS; step++) {
        const T = T0 * Math.pow(T1 / T0, step / STEPS);
        const ni = cl(i + Math.floor(rng() * 7) - 3, N), nj = cl(j + Math.floor(rng() * 7) - 3, MV);
        const dE = field[nj * N + ni] - field[j * N + i];
        if (dE <= 0 || rng() < Math.exp(-dE / T)) { i = ni; j = nj; }
      }
      k = j * N + i;
      if (!out.some((o) => Math.abs((o % N) - i) < 14 && Math.abs((o - (o % N)) / N - j) < 14)) break;
    }
    out.push(k);
  }
  return out;
}

export default function LandscapeValley({ seed = 3, runs = 0, caption }: { seed?: number; runs?: number; caption?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const terrain = makeTerrain(seed);
    const ends = runs ? runEnds(terrain.hard, runs, seed) : [];
    const draw = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const dark = document.documentElement.classList.contains("dark");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth, H = Math.round(W * 0.68);
      if (W === 0) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const { hard, channel, hardNorm } = terrain;
      const hAt = (i: number, j: number) => hard[j * N + i];
      const hScale = H * 0.03;
      const proj = (i: number, j: number, h: number): [number, number] => {
        const t = j / MV, p = 0.94 + 0.06 * t;
        return [W / 2 + (i - N / 2) * (W * 0.97 / N) * p, H * 0.06 + t * H * 0.885 - h * hScale];
      };
      const best = ends.length ? ends.reduce((a2, b2) => (hAt(b2 % N, (b2 - (b2 % N)) / N) < hAt(a2 % N, (a2 - (a2 % N)) / N) ? b2 : a2)) : -1;
      const ballRows = new Map<number, number[]>();
      for (const k of ends) {
        const j = (k - (k % N)) / N;
        ballRows.set(j, [...(ballRows.get(j) ?? []), k]);
      }
      // the same light the terrain is shaded by: from the left, a little
      // above, mostly toward the viewer
      const LX = -0.5, LY = 0.34, LZ = 0.79;
      const ballAt = (k: number) => {
        const i = k % N, j = (k - i) / N;
        const [px, py] = proj(i, j, hAt(i, j));
        const isBest = k === best;
        const r = isBest ? H * 0.026 : H * 0.021;
        const cxb = px, cyb = py - r * 0.5;
        const base: [number, number, number] = isBest
          ? dark ? [212, 168, 83] : [160, 106, 20]
          : dark ? [206, 206, 206] : [96, 96, 96];
        for (const f of ICO) {
          if (f.n[2] <= 0) continue;
          const lum = Math.max(0.32, Math.min(1.3, 0.42 + 0.85 * (f.n[0] * LX + f.n[1] * LY + f.n[2] * LZ)));
          const col = `rgb(${Math.round(Math.min(255, base[0] * lum))},${Math.round(Math.min(255, base[1] * lum))},${Math.round(Math.min(255, base[2] * lum))})`;
          ctx.beginPath();
          f.p.forEach((v, q) => {
            const x = cxb + v[0] * r, y = cyb - v[1] * r;
            if (q === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.strokeStyle = col;
          ctx.lineWidth = 0.6;
          ctx.fill();
          ctx.stroke();
        }
      };
      const base0 = dark ? [60, 64, 74] : [222, 214, 194], base1 = dark ? [124, 118, 108] : [150, 138, 118];
      const chan = dark ? [66, 124, 190] : [72, 116, 172];
      for (let j = 0; j < MV - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const k = j * N + i;
          const h00 = hAt(i, j), h10 = hAt(i + 1, j), h01 = hAt(i, j + 1), h11 = hAt(i + 1, j + 1);
          const sx = (h10 - h00 + h11 - h01) / 2, sy = (h01 - h00 + h11 - h10) / 2;
          const lum = Math.max(0.35, Math.min(1.15, 0.8 - 1.6 * sx + 0.8 * sy));
          const c = [0, 0, 0];
          const hn = hardNorm[k];
          for (let q = 0; q < 3; q++) c[q] = channel[k] ? chan[q] : base0[q] + (base1[q] - base0[q]) * hn;
          ctx.fillStyle = `rgb(${Math.round(c[0] * lum)},${Math.round(c[1] * lum)},${Math.round(c[2] * lum)})`;
          const a = proj(i, j, h00), b = proj(i + 1, j, h10), cc = proj(i + 1, j + 1, h11), d = proj(i, j + 1, h01);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(cc[0], cc[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill();
        }
        for (const k of ballRows.get(j) ?? []) ballAt(k);
      }
    };
    draw();
    const ob = new MutationObserver(draw);
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", draw);
    // a canvas that is laid out late, or a phone whose viewport changes as the
    // address bar hides, still gets its picture
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw()) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    return () => { ob.disconnect(); ro?.disconnect(); window.removeEventListener("resize", draw); };
  }, [seed, runs]);

  return (
    <figure className="my-6">
      <canvas ref={canvasRef} className="w-full block rounded" style={{ aspectRatio: "1 / 0.68" }} />
      {caption && <figcaption className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-snug">{caption}</figcaption>}
    </figure>
  );
}
