// The finish's wire router (wireRouting.ts deriveWires hands its inputs
// here). It connects each net's disconnected strip groups with link wires,
// Prim-style: always join the nearest pair of free holes. Wires may share
// endpoint holes but must not run collinearly on top of another wire, unless
// that is the only way to complete the net. It was ported line by line from
// the TypeScript router it replaced (same candidate order, same
// floating-point operations, every Map or Set iteration an ordered list here)
// and replayed the stored-skeleton fixture to the same boards.
//
// Build: npm run build:wasm into v5route.wasm beside this file. Memory is one
// bump arena, emptied by r_reset() before each call: the TypeScript side
// writes the inputs (routeWasm.ts), r_route() routes and returns a header
// of output pointers.

#include <stdint.h>

typedef int32_t i32;
typedef uint32_t u32;
typedef uint64_t u64;

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name) __attribute__((visibility("default")))
#endif

// ── arena ──

static uintptr_t heapTop;

#ifdef __wasm__
extern unsigned char __heap_base;
#define ARENA_START ((uintptr_t)&__heap_base)
#define ARENA_ORIGIN ((uintptr_t)0)
static void *balloc(u32 n) {
  uintptr_t p = (heapTop + 7) & ~(uintptr_t)7;
  uintptr_t end = p + n;
  uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * 65536;
  if (end > have) {
    uintptr_t pages = (end - have + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (uintptr_t)-1) __builtin_trap();
  }
  heapTop = end;
  return (void *)p;
}
#else
// native build (the test harness's faster copy, tests/solver/native): the
// host hands over one fixed block; addresses JS sees are offsets into it
static uintptr_t arenaBase, arenaEnd;
EXPORT(native_setArena) void native_setArena(void *base, unsigned long long bytes) { arenaBase = (uintptr_t)base; arenaEnd = arenaBase + bytes; }
#define ARENA_START arenaBase
#define ARENA_ORIGIN arenaBase
static void *balloc(u32 n) {
  uintptr_t p = (heapTop + 7) & ~(uintptr_t)7;
  uintptr_t end = p + n;
  if (end > arenaEnd) __builtin_trap();
  heapTop = end;
  return (void *)p;
}
#endif
// an address as JS reads it: an offset into the WebAssembly memory or the
// native block (an empty list's null stays 0, as in WebAssembly)
#define JSPTR(p) ((p) ? (i32)((uintptr_t)(p) - ARENA_ORIGIN) : 0)
#define ALLOC(T, n) ((T *)balloc((u32)(sizeof(T) * (u32)(n))))

EXPORT(r_reset) void r_reset(void) { heapTop = ARENA_START; }
EXPORT(r_alloc) void *r_alloc(i32 bytes) { return balloc((u32)bytes); }

static void fillI(i32 *a, i32 v, i32 n) { for (i32 i = 0; i < n; i++) a[i] = v; }
static void fillB(uint8_t *a, uint8_t v, i32 n) { for (i32 i = 0; i < n; i++) a[i] = v; }
static inline i32 imax(i32 a, i32 b) { return a > b ? a : b; }
static inline i32 imin(i32 a, i32 b) { return a < b ? a : b; }
static inline i32 iabs(i32 a) { return a < 0 ? -a : a; }
static inline double dmax(double a, double b) { return a > b ? a : b; }
static inline double dmin(double a, double b) { return a < b ? a : b; }
static inline double dabs(double a) { return a < 0 ? -a : a; }
#define INF __builtin_inf()
#define FAR (1 << 29)

// growable list of ints, taken from the arena (the old block is left behind)
typedef struct { i32 *a; i32 n, cap; } Vec;
static void vpush(Vec *v, i32 x) {
  if (v->n == v->cap) {
    i32 nc = v->cap ? v->cap * 2 : 8;
    i32 *na = ALLOC(i32, nc);
    for (i32 i = 0; i < v->n; i++) na[i] = v->a[i];
    v->a = na;
    v->cap = nc;
  }
  v->a[v->n++] = x;
}

// V8's Math.hypot for two arguments (math.tq: scaled Kahan sum), which is
// not always sqrt(x*x + y*y) in the last bit
static double hypot2(double x, double y) {
  double a = dabs(x), b = dabs(y);
  double max = 0;
  if (a > max) max = a;
  if (b > max) max = b;
  if (max == 0) return 0;
  double sum = 0, comp = 0;
  double n = a / max, s = n * n - comp, p = sum + s;
  comp = (p - sum) - s;
  sum = p;
  n = b / max; s = n * n - comp; p = sum + s;
  sum = p;
  return __builtin_sqrt(sum) * max;
}

// ── routing cost model (the wire prices are flexGeometry.ts's) ──

#define WIRE_OFFAXIS_FREE 1.0
#define WIRE_OFFAXIS_RATE 2.0
#define WIRE_CROSS_EXTRA 8.0
#define WIRE_STRICT_MESS 1000.0
#define WIRE_STACK_RESCUE 1000.0
// Wires running on top of each other are physically fine (insulation) and a
// standard human technique for parallel runs sharing a column; the editor
// draws them in separate lanes. Priced by the depth of the stack a wire
// joins: the second wire in a channel still beats a slant, the third only a
// real detour, a fourth is barred unless nothing else completes the net.
static const double WIRE_STACK_PRICES[3] = {0, 6, 15};
// Every candidate multiplies the per-wire relay search; big boards can offer
// a hundred tails. Keep the free groups plus the widest tails.
#define MAX_RELAY_CANDS 32
// A group with no free hole left can still take a link wire by sharing a
// same-net pin's hole: the wire is soldered into the pin's joint, as humans
// do on tight-pitch connectors and grid parts whose interior pins sit on
// single-hole segments. Real holes always win: a shared joint is priced as
// extra wire length, so layouts that avoid it keep beating ones that need it.
#define PIN_SHARE_PENALTY 4.0
// Relay route: two vertical hops through an unclaimed pin-free strip,
// competing with the direct wire on the same cost scale. The extra solder
// joint costs a small flat tax, so a clean direct vertical still wins; a
// slanted direct wire usually loses.
#define RELAY_WIRE_TAX 1.0
// A wire end in a hole that already holds one: a quarter of a hole of wire,
// so it only ever decides between otherwise equal choices. It stays out of
// the mess, which is about tidiness and decides when the relay search runs.
#define WIRE_SHARED_HOLE 0.25

// ── geometry (flexGeometry.ts; the same functions as in decode.c) ──

static double orient(double ar, double ac, double br, double bc, double cr, double cc) {
  return (bc - ac) * (cr - ar) - (br - ar) * (cc - ac);
}
static int onSegment(double ar, double ac, double br, double bc, double pr, double pc) {
  return dmin(ar, br) - 1e-9 <= pr && pr <= dmax(ar, br) + 1e-9 &&
         dmin(ac, bc) - 1e-9 <= pc && pc <= dmax(ac, bc) + 1e-9;
}
static int segmentsIntersect(double a1r, double a1c, double a2r, double a2c, double b1r, double b1c, double b2r, double b2c) {
  double o1 = orient(a1r, a1c, a2r, a2c, b1r, b1c);
  double o2 = orient(a1r, a1c, a2r, a2c, b2r, b2c);
  double o3 = orient(b1r, b1c, b2r, b2c, a1r, a1c);
  double o4 = orient(b1r, b1c, b2r, b2c, a2r, a2c);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 1;
  if (dabs(o1) < 1e-9 && onSegment(a1r, a1c, a2r, a2c, b1r, b1c)) return 1;
  if (dabs(o2) < 1e-9 && onSegment(a1r, a1c, a2r, a2c, b2r, b2c)) return 1;
  if (dabs(o3) < 1e-9 && onSegment(b1r, b1c, b2r, b2c, a1r, a1c)) return 1;
  if (dabs(o4) < 1e-9 && onSegment(b1r, b1c, b2r, b2c, a2r, a2c)) return 1;
  return 0;
}
static double pointSegmentDistance(double pr, double pc, double ar, double ac, double br, double bc) {
  double dr = br - ar, dc = bc - ac;
  double lenSq = dr * dr + dc * dc;
  double t = 0;
  if (lenSq > 0) {
    t = ((pr - ar) * dr + (pc - ac) * dc) / lenSq;
    t = dmax(0, dmin(1, t));
  }
  double nr = ar + t * dr - pr;
  double nc = ac + t * dc - pc;
  return __builtin_sqrt(nr * nr + nc * nc);
}
static double segmentSegmentDistance(double a1r, double a1c, double a2r, double a2c, double b1r, double b1c, double b2r, double b2c) {
  if (segmentsIntersect(a1r, a1c, a2r, a2c, b1r, b1c, b2r, b2c)) return 0;
  double d = pointSegmentDistance(b1r, b1c, a1r, a1c, a2r, a2c);
  d = dmin(d, pointSegmentDistance(b2r, b2c, a1r, a1c, a2r, a2c));
  d = dmin(d, pointSegmentDistance(a1r, a1c, b1r, b1c, b2r, b2c));
  d = dmin(d, pointSegmentDistance(a2r, a2c, b1r, b1c, b2r, b2c));
  return d;
}
static int segmentIntersectsRect(double p1r, double p1c, double p2r, double p2c, double minR, double minC, double maxR, double maxC) {
  if ((p1r >= minR && p1r <= maxR && p1c >= minC && p1c <= maxC) ||
      (p2r >= minR && p2r <= maxR && p2c >= minC && p2c <= maxC)) return 1;
  return segmentsIntersect(p1r, p1c, p2r, p2c, minR, minC, minR, maxC) ||
         segmentsIntersect(p1r, p1c, p2r, p2c, minR, maxC, maxR, maxC) ||
         segmentsIntersect(p1r, p1c, p2r, p2c, maxR, maxC, maxR, minC) ||
         segmentsIntersect(p1r, p1c, p2r, p2c, maxR, minC, minR, minC);
}
static int segmentsOverlapCollinear(double a1r, double a1c, double a2r, double a2c, double b1r, double b1c, double b2r, double b2c) {
  double dr = a2r - a1r, dc = a2c - a1c;
  if (dabs(dr * (b2c - b1c) - dc * (b2r - b1r)) > 1e-9) return 0;
  if (dabs(dr * (b1c - a1c) - dc * (b1r - a1r)) > 1e-9) return 0;
  double pa1 = a1r * dr + a1c * dc, pa2 = a2r * dr + a2c * dc;
  double pb1 = b1r * dr + b1c * dc, pb2 = b2r * dr + b2c * dc;
  double aMin = dmin(pa1, pa2), aMax = dmax(pa1, pa2), bMin = dmin(pb1, pb2), bMax = dmax(pb1, pb2);
  return dmin(aMax, bMax) - dmax(aMin, bMin) > 1e-9;
}

// ── call state ──

static i32 R, C, NH, strict, allowShared, skipRelays, drill, noStack;
static i32 *segRow, *segStart, *segEnd, nSeg;

// obstacles (WireObstacleIndex): rects, then flexible bodies
static i32 nRect, nBody, nObs;
static double *rc;  // rects: minRow, minCol, maxRow, maxCol
static double *bd;  // bodies: p1r, p1c, p2r, p2c, hasCore, ar, ac, br, bc, r
static double *obMinRow, *obMaxRow;
static i32 obBase, obBuckets, *bkStart, *bkList, *obStamp, obGen;
// pair memo: the value first computed for a pair serves both directions
static u64 *memoKey;
static double *memoVal;
static i32 memoCap, memoN;

static void obstacleInit(void) {
  nObs = nRect + nBody;
  obMinRow = ALLOC(double, nObs + 1);
  obMaxRow = ALLOC(double, nObs + 1);
  double *minC = ALLOC(double, nObs + 1), *maxC = ALLOC(double, nObs + 1);
  for (i32 i = 0; i < nRect; i++) {
    obMinRow[i] = rc[4 * i];
    obMaxRow[i] = rc[4 * i + 2];
    minC[i] = rc[4 * i + 1];
    maxC[i] = rc[4 * i + 3];
  }
  for (i32 j = 0; j < nBody; j++) {
    double *b = bd + 10 * j;
    double pad = b[4] != 0 ? b[9] : 0;
    i32 i = nRect + j;
    obMinRow[i] = dmin(b[0], b[2]) - pad;
    obMaxRow[i] = dmax(b[0], b[2]) + pad;
    minC[i] = dmin(b[1], b[3]) - pad;
    maxC[i] = dmax(b[1], b[3]) + pad;
  }
  double lo = INF, hi = -INF;
  for (i32 i = 0; i < nObs; i++) {
    if (minC[i] < lo) lo = __builtin_floor(minC[i]);
    if (maxC[i] > hi) hi = __builtin_ceil(maxC[i]);
  }
  obBuckets = 0;
  obBase = 0;
  if (nObs > 0) {
    obBase = (i32)lo;
    obBuckets = (i32)hi - obBase + 1;
    bkStart = ALLOC(i32, obBuckets + 1);
    fillI(bkStart, 0, obBuckets + 1);
    for (i32 i = 0; i < nObs; i++)
      for (i32 c = (i32)__builtin_floor(minC[i]); c <= (i32)__builtin_ceil(maxC[i]); c++) bkStart[c - obBase + 1]++;
    for (i32 b = 0; b < obBuckets; b++) bkStart[b + 1] += bkStart[b];
    i32 *fill = ALLOC(i32, obBuckets);
    for (i32 b = 0; b < obBuckets; b++) fill[b] = bkStart[b];
    bkList = ALLOC(i32, bkStart[obBuckets] + 1);
    for (i32 i = 0; i < nObs; i++)
      for (i32 c = (i32)__builtin_floor(minC[i]); c <= (i32)__builtin_ceil(maxC[i]); c++) bkList[fill[c - obBase]++] = i;
  }
  obStamp = ALLOC(i32, nObs + 1);
  fillI(obStamp, 0, nObs + 1);
  obGen = 0;
  memoCap = 4096;
  memoN = 0;
  memoKey = ALLOC(u64, memoCap);
  memoVal = ALLOC(double, memoCap);
  for (i32 i = 0; i < memoCap; i++) memoKey[i] = ~(u64)0;
}

static inline u32 memoSlot(u64 key, i32 cap) {
  return (u32)(((key * 0x9e3779b97f4a7c15ull) >> 32) & (u64)(cap - 1));
}
static void memoPut(u64 key, double v) {
  if (2 * (memoN + 1) > memoCap) {
    u64 *ok = memoKey;
    double *ov = memoVal;
    i32 oc = memoCap;
    memoCap *= 2;
    memoKey = ALLOC(u64, memoCap);
    memoVal = ALLOC(double, memoCap);
    for (i32 i = 0; i < memoCap; i++) memoKey[i] = ~(u64)0;
    memoN = 0;
    for (i32 i = 0; i < oc; i++) if (ok[i] != ~(u64)0) memoPut(ok[i], ov[i]);
  }
  u32 i = memoSlot(key, memoCap);
  while (memoKey[i] != ~(u64)0) i = (i + 1) & (u32)(memoCap - 1);
  memoKey[i] = key;
  memoVal[i] = v;
  memoN++;
}

// WireObstacleIndex.extraLength
static double extraLength(i32 fr, i32 fc, i32 tr, i32 tc) {
  u64 a = (u64)(u32)(fr * C + fc), b = (u64)(u32)(tr * C + tc);
  u64 key = a < b ? (a << 32) | b : (b << 32) | a;
  for (u32 i = memoSlot(key, memoCap);; i = (i + 1) & (u32)(memoCap - 1)) {
    if (memoKey[i] == key) return memoVal[i];
    if (memoKey[i] == ~(u64)0) break;
  }
  double dr = iabs(tr - fr), dc = iabs(tc - fc);
  double extra = 0;
  if (dc > 1e-9) extra += strict ? WIRE_STRICT_MESS : WIRE_OFFAXIS_RATE * dmax(0, hypot2(dr, dc) - WIRE_OFFAXIS_FREE);
  double crossExtra = strict ? WIRE_STRICT_MESS : WIRE_CROSS_EXTRA;
  double minR = imin(fr, tr), maxR = imax(fr, tr);
  i32 cLo = imax(imin(fc, tc) - obBase, 0);
  i32 cHi = imin(imax(fc, tc) - obBase, obBuckets - 1);
  i32 gen = ++obGen;
  for (i32 c = cLo; c <= cHi; c++) {
    for (i32 k = bkStart[c]; k < bkStart[c + 1]; k++) {
      i32 oi = bkList[k];
      if (obStamp[oi] == gen) continue;
      obStamp[oi] = gen;
      if (obMaxRow[oi] < minR || obMinRow[oi] > maxR) continue;
      if (oi < nRect) {
        double *r = rc + 4 * oi;
        if (segmentIntersectsRect(fr, fc, tr, tc, r[0], r[1], r[2], r[3])) extra += crossExtra;
      } else {
        double *q = bd + 10 * (oi - nRect);
        // wireCrossesBody
        if (segmentsIntersect(fr, fc, tr, tc, q[0], q[1], q[2], q[3]) ||
            (q[4] != 0 && segmentSegmentDistance(fr, fc, tr, tc, q[5], q[6], q[7], q[8]) < q[9] - 0.05))
          extra += crossExtra;
      }
    }
  }
  memoPut(key, extra);
  return extra;
}

// ── wires of the pass (WireStackIndex) ──

static i32 *wFr, *wFc, *wTr, *wTc, nW, nExist;
static Vec *stCol, *stRow, stSlant;
static i32 *ivLo, *ivHi;

static void stackAdd(i32 w) {
  if (wFc[w] == wTc[w]) vpush(&stCol[wFc[w]], w);
  else if (wFr[w] == wTr[w]) vpush(&stRow[wFr[w]], w);
  else vpush(&stSlant, w);
}
// axisStackDepth: the most intervals holding one start point
static i32 axisDepth(i32 a, i32 b, Vec *list, i32 vertical) {
  i32 aMin = imin(a, b), aMax = imax(a, b), n = 0;
  for (i32 k = 0; k < list->n; k++) {
    i32 w = list->a[k];
    i32 p = vertical ? wFr[w] : wFc[w], q = vertical ? wTr[w] : wTc[w];
    i32 lo = imax(aMin, imin(p, q)), hi = imin(aMax, imax(p, q));
    if (hi - lo <= 0) continue;
    ivLo[n] = lo;
    ivHi[n] = hi;
    n++;
  }
  i32 max = 0;
  for (i32 i = 0; i < n; i++) {
    i32 x = ivLo[i], d = 0;
    for (i32 j = 0; j < n; j++) if (ivLo[j] <= x && x <= ivHi[j]) d++;
    if (d > max) max = d;
  }
  return max;
}
// wireStackDepth against the slanted wires: the same sweep answer as the
// sorted events, counted at each start point
static i32 slantDepth(i32 fr, i32 fc, i32 tr, i32 tc) {
  double dr = tr - fr, dc = tc - fc;
  double pf = fr * dr + fc * dc, pt = tr * dr + tc * dc;
  double aMin = dmin(pf, pt), aMax = dmax(pf, pt);
  i32 n = 0;
  double *lo = (double *)ivLo, *hi = (double *)ivHi;
  for (i32 k = 0; k < stSlant.n; k++) {
    i32 w = stSlant.a[k];
    if (!segmentsOverlapCollinear(fr, fc, tr, tc, wFr[w], wFc[w], wTr[w], wTc[w])) continue;
    double p1 = wFr[w] * dr + wFc[w] * dc, p2 = wTr[w] * dr + wTc[w] * dc;
    lo[n] = dmax(aMin, dmin(p1, p2));
    hi[n] = dmin(aMax, dmax(p1, p2));
    n++;
  }
  i32 max = 0;
  for (i32 i = 0; i < n; i++) {
    double x = lo[i];
    i32 d = 0;
    for (i32 j = 0; j < n; j++) if (lo[j] <= x && x <= hi[j]) d++;
    if (d > max) max = d;
  }
  return max;
}
static i32 stackDepth(i32 fr, i32 fc, i32 tr, i32 tc) {
  if (fc == tc) {
    if (fr == tr) return 0;
    return axisDepth(fr, tr, &stCol[fc], 1);
  }
  if (fr == tr) return axisDepth(fc, tc, &stRow[fr], 0);
  return stSlant.n > 0 ? slantDepth(fr, fc, tr, tc) : 0;
}
static i32 allowDeepStacks;
static double overlapPenalty(i32 fr, i32 fc, i32 tr, i32 tc) {
  i32 depth = stackDepth(fr, fc, tr, tc);
  if (noStack) return WIRE_STRICT_MESS * depth;
  if (depth < 3) return WIRE_STACK_PRICES[depth];
  return allowDeepStacks ? WIRE_STACK_RESCUE * (depth - 3 + 1) : INF;
}

// ── column maps (byColOf): distinct columns in first-seen order, each with
// its rows in order ──

static Vec cmN, cmFirst, cmCol, cmRowStart, cmRowCnt, cmRows;
static i32 *colSlot, *colSlotGen, colGen;

static i32 colMapOf(const i32 *holes, i32 n) {
  i32 h = cmN.n, first = cmCol.n, gen = ++colGen;
  vpush(&cmN, 0);
  vpush(&cmFirst, first);
  for (i32 i = 0; i < n; i++) {
    i32 c = holes[i] % C;
    if (colSlotGen[c] != gen) {
      colSlotGen[c] = gen;
      colSlot[c] = cmCol.n;
      vpush(&cmCol, c);
      vpush(&cmRowStart, 0);
      vpush(&cmRowCnt, 0);
    }
    cmRowCnt.a[colSlot[c]]++;
  }
  i32 nc = cmCol.n - first, at = cmRows.n;
  for (i32 k = first; k < cmCol.n; k++) {
    cmRowStart.a[k] = at;
    at += cmRowCnt.a[k];
    cmRowCnt.a[k] = 0;
  }
  for (i32 i = 0; i < n; i++) vpush(&cmRows, 0);
  for (i32 i = 0; i < n; i++) {
    i32 k = colSlot[holes[i] % C];
    cmRows.a[cmRowStart.a[k] + cmRowCnt.a[k]++] = holes[i] / C;
  }
  cmN.a[h] = nc;
  return h;
}

// ── routing ──

static i32 nGroups, *gSegStart, *gSegIdx, nPins, *pinRow, *pinCol, *pinNet, nNetIds, nRoute, *reserve;
static i32 *segAt, *segToGroup, *gFreeStart, *gFreeCnt, *freeH;
static i32 *ngStart, *ngCnt, *ngList, *gpStart, *gpCnt, *gpH;
static uint8_t *occ, *pinHole, *wireEnds, *donated, *sharedPen;
static i32 *epStart, *epCnt, *epDone;
static Vec epPool;
static i32 *bcHandle, *bcGen, bcEpoch;

// relay candidates
static i32 nCand, candCap;
static i32 *cHStart, *cHCnt, *cSStart, *cSCnt, *cByCol, *cHasCut, *cCutRow, *cCutCol, *cCutKind;
static i32 *cDonorGroup, *cDonorNet, *cDonorNeedy, *cSplit, *cOwner;
static Vec cHoles, cSet;
static Vec owned;  // relayOwner keys in first-claim order

static i32 inSet(i32 ci, i32 h) {
  i32 lo = cSStart[ci], hi = cSStart[ci] + cSCnt[ci];
  while (lo < hi) {
    i32 mid = (lo + hi) >> 1;
    if (cSet.a[mid] < h) lo = mid + 1;
    else hi = mid;
  }
  return lo < cSStart[ci] + cSCnt[ci] && cSet.a[lo] == h;
}
static void sortInts(i32 *a, i32 n) {
  for (i32 i = 1; i < n; i++) {
    i32 x = a[i], j = i - 1;
    while (j >= 0 && a[j] > x) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
}
static void addCand(const i32 *holes, i32 n, i32 extraHole, i32 hasCut, i32 cutRow, i32 cutCol, i32 cutKind,
                    i32 donorGroup, i32 donorNet, i32 donorNeedy) {
  i32 ci = nCand++;
  cHStart[ci] = cHoles.n;
  for (i32 i = 0; i < n; i++) vpush(&cHoles, holes[i]);
  cHCnt[ci] = n;
  cSStart[ci] = cSet.n;
  for (i32 i = 0; i < n; i++) vpush(&cSet, holes[i]);
  if (extraHole >= 0) vpush(&cSet, extraHole);
  cSCnt[ci] = cSet.n - cSStart[ci];
  sortInts(cSet.a + cSStart[ci], cSCnt[ci]);
  cByCol[ci] = colMapOf(cHoles.a + cHStart[ci], n);
  cHasCut[ci] = hasCut;
  cCutRow[ci] = cutRow;
  cCutCol[ci] = cutCol;
  cCutKind[ci] = cutKind;
  cDonorGroup[ci] = donorGroup;
  cDonorNet[ci] = donorNet;
  cDonorNeedy[ci] = donorNeedy;
  cSplit[ci] = 0;
  cOwner[ci] = -1;
}

// endpointHolesOfGroup: free holes, or the group's pin holes (shared joints)
static void endpointsOf(i32 gi) {
  if (epDone[gi]) return;
  epDone[gi] = 1;
  epStart[gi] = epPool.n;
  if (gFreeCnt[gi] > 0 || !allowShared) {
    for (i32 k = 0; k < gFreeCnt[gi]; k++) vpush(&epPool, freeH[gFreeStart[gi] + k]);
  } else {
    for (i32 k = 0; k < gpCnt[gi]; k++) {
      i32 h = gpH[gpStart[gi] + k];
      vpush(&epPool, h);
      sharedPen[h] = 1;
    }
  }
  epCnt[gi] = epPool.n - epStart[gi];
}
static Vec tmpHoles;
// bColsOf: the pass endpoints by column, rebuilt after a donation
static i32 bColsOf(i32 gi) {
  if (bcGen[gi] == bcEpoch) return bcHandle[gi];
  endpointsOf(gi);
  tmpHoles.n = 0;
  for (i32 k = 0; k < epCnt[gi]; k++) {
    i32 h = epPool.a[epStart[gi] + k];
    if (!donated[h]) vpush(&tmpHoles, h);
  }
  bcHandle[gi] = colMapOf(tmpHoles.a, tmpHoles.n);
  bcGen[gi] = bcEpoch;
  return bcHandle[gi];
}

// the net's connected copper: holes by row (sorted columns) and by column
// (columns in first-added order, rows in added order)
static Vec *conRow;
static Vec conTouched, conCols, conNodeRow, conNodeNext;
static i32 *conHead, *conTail, *conSeen, conGen, connMinRow, connMaxRow;

static void addConnected(i32 h) {
  i32 row = h / C, col = h % C;
  Vec *v = &conRow[row];
  if (v->n == 0) vpush(&conTouched, row);
  i32 lo = 0, hi = v->n;
  while (lo < hi) {
    i32 mid = (lo + hi) >> 1;
    if (v->a[mid] < col) lo = mid + 1;
    else hi = mid;
  }
  vpush(v, 0);
  for (i32 k = v->n - 1; k > lo; k--) v->a[k] = v->a[k - 1];
  v->a[lo] = col;
  if (row < connMinRow) connMinRow = row;
  if (row > connMaxRow) connMaxRow = row;
  i32 node = conNodeRow.n;
  vpush(&conNodeRow, row);
  vpush(&conNodeNext, -1);
  if (conSeen[col] != conGen) {
    conSeen[col] = conGen;
    vpush(&conCols, col);
    conHead[col] = node;
  } else conNodeNext.a[conTail[col]] = node;
  conTail[col] = node;
}

typedef struct { i32 fr, fc, tr, tc; double cost, mess, shared; } Hop;

static double sharedHole(i32 fr, i32 fc, i32 tr, i32 tc) {
  return (wireEnds[fr * C + fc] ? WIRE_SHARED_HOLE : 0) + (wireEnds[tr * C + tc] ? WIRE_SHARED_HOLE : 0);
}
static inline double pen(i32 row, i32 col) { return sharedPen[row * C + col] ? PIN_SHARE_PENALTY : 0; }

static i32 *bSlot, *bSlotGen, bGen;
// vertHop: the cheapest vertical hop between two column maps; colsA is the
// connected copper when handleA < 0
static i32 vertHop(i32 handleA, i32 handleB, Hop *best) {
  i32 found = 0, gen = ++bGen;
  i32 fB = cmFirst.a[handleB];
  for (i32 k = 0; k < cmN.a[handleB]; k++) {
    bSlotGen[cmCol.a[fB + k]] = gen;
    bSlot[cmCol.a[fB + k]] = fB + k;
  }
  i32 nA = handleA < 0 ? conCols.n : cmN.a[handleA];
  i32 fA = handleA < 0 ? 0 : cmFirst.a[handleA];
  for (i32 ka = 0; ka < nA; ka++) {
    i32 col = handleA < 0 ? conCols.a[ka] : cmCol.a[fA + ka];
    if (bSlotGen[col] != gen) continue;
    i32 sb = bSlot[col];
    i32 nodeA = handleA < 0 ? conHead[col] : 0, ia = 0;
    for (;;) {
      i32 ra;
      if (handleA < 0) {
        if (nodeA < 0) break;
        ra = conNodeRow.a[nodeA];
      } else {
        if (ia >= cmRowCnt.a[fA + ka]) break;
        ra = cmRows.a[cmRowStart.a[fA + ka] + ia];
      }
      for (i32 ib = 0; ib < cmRowCnt.a[sb]; ib++) {
        i32 rb = cmRows.a[cmRowStart.a[sb] + ib];
        double d = iabs(ra - rb);
        if (found && d >= best->cost + 1e-9) continue;
        double mess = extraLength(ra, col, rb, col) + pen(ra, col) + pen(rb, col);
        if (found && d + mess >= best->cost - 1e-9) continue;
        mess += overlapPenalty(ra, col, rb, col);
        if (!__builtin_isfinite(mess)) continue;
        double shared = sharedHole(ra, col, rb, col);
        double cost = d + mess + shared;
        if (!found || cost < best->cost - 1e-9) {
          found = 1;
          best->fr = ra; best->fc = col; best->tr = rb; best->tc = col;
          best->cost = cost; best->mess = mess; best->shared = shared;
        }
      }
      if (handleA < 0) nodeA = conNodeNext.a[nodeA];
      else ia++;
    }
  }
  return found;
}

static double slantLowerBound(double dr, double dc) {
  double dist = hypot2(dr, dc);
  if (dc == 0) return dist;
  return dist + (strict ? WIRE_STRICT_MESS : WIRE_OFFAXIS_RATE * dmax(0, dist - WIRE_OFFAXIS_FREE));
}

// remaining groups of the net being routed, in insertion order
static Vec remList;
static i32 *remAlive, remGen, remCount;
static i32 curNet;

typedef struct { i32 fr, fc, tr, tc, group; double cost, mess, shared; } Choice;

static i32 findBest(Choice *best) {
  i32 found = 0;
  for (i32 ri = 0; ri < remList.n; ri++) {
    i32 gi = remList.a[ri];
    if (remAlive[gi] != remGen) continue;
    endpointsOf(gi);
    for (i32 e = 0; e < epCnt[gi]; e++) {
      i32 hbh = epPool.a[epStart[gi] + e];
      if (donated[hbh]) continue;
      i32 hbr = hbh / C, hbc = hbh % C;
      i32 maxDr = imax(hbr - connMinRow, connMaxRow - hbr);
      for (i32 dr = 0; dr <= maxDr; dr++) {
        if (found && dr > best->cost + 1e-9) break;
        for (i32 side = 0; side < (dr == 0 ? 1 : 2); side++) {
          i32 row = dr == 0 ? hbr : side == 0 ? hbr - dr : hbr + dr;
          if (row < 0 || row >= R) continue;
          Vec *cols = &conRow[row];
          if (cols->n == 0) continue;
          i32 lo = 0, hi = cols->n;
          while (lo < hi) {
            i32 mid = (lo + hi) >> 1;
            if (cols->a[mid] < hbc) lo = mid + 1;
            else hi = mid;
          }
          for (i32 pass = 0; pass < 2; pass++) {
            for (i32 k = pass == 0 ? lo : lo - 1; pass == 0 ? k < cols->n : k >= 0; k += pass == 0 ? 1 : -1) {
              i32 col = cols->a[k];
              if (found && slantLowerBound(dr, pass == 0 ? col - hbc : hbc - col) > best->cost + 1e-9) break;
              // consider(row, col, hb, gi)
              double dc = col - hbc;
              double dist = hypot2(row - hbr, dc);
              if (found && dist >= best->cost + 1e-9) continue;
              if (found && slantLowerBound(row - hbr, dc) > best->cost + 1e-9) continue;
              double mess = extraLength(row, col, hbr, hbc) + pen(row, col) + pen(hbr, hbc);
              if (found && dist + mess > best->cost + 1e-9) continue;
              mess += overlapPenalty(row, col, hbr, hbc);
              if (!__builtin_isfinite(mess)) continue;
              double shared = sharedHole(row, col, hbr, hbc);
              double cost = dist + mess + shared;
              int better = !found || cost < best->cost - 1e-9 ||
                           (cost < best->cost + 1e-9 && dabs(dc) < dabs((double)(best->fc - best->tc)));
              if (!better) continue;
              found = 1;
              best->fr = row; best->fc = col; best->tr = hbr; best->tc = hbc;
              best->group = gi; best->cost = cost; best->mess = mess; best->shared = shared;
            }
          }
        }
      }
    }
  }
  return found;
}

typedef struct { Hop w1, w2; i32 group, relay; double cost, mess; } Relay;

static uint8_t *w1State;
static Hop *w1Hop;

static i32 findRelayBest(double maxHops, Relay *best) {
  i32 found = 0, n = nCand;
  for (i32 ci = 0; ci < n; ci++) w1State[ci] = 0;
  for (i32 ri = 0; ri < remList.n; ri++) {
    i32 gi = remList.a[ri];
    if (remAlive[gi] != remGen) continue;
    i32 bCols = bColsOf(gi);
    if (cmN.a[bCols] == 0) continue;
    for (i32 ci = 0; ci < n; ci++) {
      i32 owner = cOwner[ci];
      if (owner >= 0 && owner != curNet) continue;
      if (cDonorNet[ci] == curNet) continue;
      if (owner < 0 && cHasCut[ci]) {
        i32 blocked = 0;
        for (i32 k = 0; k < cSCnt[ci]; k++) {
          i32 h = cSet.a[cSStart[ci] + k];
          if (wireEnds[h] || donated[h]) { blocked = 1; break; }
        }
        if (blocked) continue;
        if (cDonorNeedy[ci]) {
          i32 dg = cDonorGroup[ci], keeps = 0;
          for (i32 k = 0; k < gFreeCnt[dg]; k++) {
            i32 h = freeH[gFreeStart[dg] + k];
            if (donated[h]) continue;
            if (!inSet(ci, h)) { keeps = 1; break; }
          }
          if (!keeps) continue;
        }
      }
      if (w1State[ci] == 0) w1State[ci] = vertHop(-1, cByCol[ci], &w1Hop[ci]) ? 2 : 1;
      if (w1State[ci] == 1) continue;
      Hop w2;
      if (!vertHop(cByCol[ci], bCols, &w2)) continue;
      Hop *w1 = &w1Hop[ci];
      double hops = w1->cost - w1->shared + w2.cost - w2.shared;
      if (hops > maxHops) continue;
      double cost = hops + RELAY_WIRE_TAX + (cHasCut[ci] && owner < 0 ? 0.5 : 0);
      if (found && cost >= best->cost - 1e-9) continue;
      found = 1;
      best->w1 = *w1;
      best->w2 = w2;
      best->group = gi;
      best->relay = ci;
      best->cost = cost;
      best->mess = w1->mess + w2.mess;
    }
  }
  return found;
}

// Relays exist to avoid messy wires, not to shorten clean ones: a clean direct
// wire skips the relay search. Outside strict mode a relay may only replace a
// messy wire when its hops stay comparable in length (a huge detour to save a
// slant builds worse than the slant); with no direct option anything goes.
static i32 search(Choice *best, i32 *hasBest, Relay *relay) {
  *hasBest = findBest(best);
  double maxHops = *hasBest && !strict ? hypot2(best->fr - best->tr, best->fc - best->tc) * 1.5 + 4 : INF;
  return (!*hasBest || best->mess > 0.25) ? findRelayBest(maxHops, relay) : 0;
}

// output
static Vec outWires, outCuts, outEv, outEvPins;
static double passMess;
static i32 sharedJoints;

static void pushWire(i32 fr, i32 fc, i32 tr, i32 tc) {
  i32 w = nW++;
  wFr[w] = fr; wFc[w] = fc; wTr[w] = tr; wTc[w] = tc;
  stackAdd(w);
  wireEnds[fr * C + fc] = 1;
  wireEnds[tr * C + tc] = 1;
  if (sharedPen[fr * C + fc] || sharedPen[tr * C + tc]) sharedJoints++;
  vpush(&outWires, fr); vpush(&outWires, fc); vpush(&outWires, tr); vpush(&outWires, tc);
}
// a starvation issue for the net and the pins of its groups without free holes
static void starve(i32 type, i32 net) {
  vpush(&outEv, type);
  vpush(&outEv, net);
  vpush(&outEv, outEvPins.n / 2);
  i32 n0 = outEvPins.n;
  for (i32 k = 0; k < ngCnt[net]; k++) {
    i32 gi = ngList[ngStart[net] + k];
    if (gFreeCnt[gi] != 0) continue;
    for (i32 j = 0; j < gpCnt[gi]; j++) {
      vpush(&outEvPins, gpH[gpStart[gi] + j] / C);
      vpush(&outEvPins, gpH[gpStart[gi] + j] % C);
    }
  }
  vpush(&outEv, (outEvPins.n - n0) / 2);
}

static i32 *outHdr;
static double outMess;

// in: R, C, nSeg, nGroups, nGroupIdx, nPins, nOcc, nExist, nNetIds, nRoute, nRect, nBody, flags,
// then segRow/segStart/segEnd, groupStart[nGroups + 1], groupIdx, pinRow/pinCol/pinNet
// (-1 null), occupied (row, col) pairs, existing wires (fr, fc, tr, tc), reserve[nNetIds];
// inD: rects (minRow, minCol, maxRow, maxCol), bodies (p1r, p1c, p2r, p2c, hasCore, ar, ac, br, bc, r)
EXPORT(r_route) i32 *r_route(i32 *in, double *inD) {
  R = in[0]; C = in[1]; nSeg = in[2]; nGroups = in[3];
  i32 nGroupIdx = in[4];
  nPins = in[5];
  i32 nOcc = in[6];
  nExist = in[7]; nNetIds = in[8]; nRoute = in[9]; nRect = in[10]; nBody = in[11];
  i32 flags = in[12];
  strict = flags & 1; allowShared = (flags >> 1) & 1; skipRelays = (flags >> 2) & 1;
  drill = (flags >> 3) & 1; noStack = (flags >> 4) & 1;
  i32 *p = in + 13;
  segRow = p; p += nSeg; segStart = p; p += nSeg; segEnd = p; p += nSeg;
  gSegStart = p; p += nGroups + 1; gSegIdx = p; p += nGroupIdx;
  pinRow = p; p += nPins; pinCol = p; p += nPins; pinNet = p; p += nPins;
  i32 *occIn = p; p += 2 * nOcc;
  i32 *exist = p; p += 4 * nExist;
  reserve = p; p += nNetIds;
  rc = inD;
  bd = inD + 4 * nRect;
  NH = R * C;

  obstacleInit();
  occ = ALLOC(uint8_t, NH); fillB(occ, 0, NH);
  for (i32 i = 0; i < nOcc; i++) {
    i32 r = occIn[2 * i], c = occIn[2 * i + 1];
    if (r >= 0 && r < R && c >= 0 && c < C) occ[r * C + c] = 1;
  }
  pinHole = ALLOC(uint8_t, NH); fillB(pinHole, 0, NH);
  for (i32 i = 0; i < nPins; i++) pinHole[pinRow[i] * C + pinCol[i]] = 1;
  wireEnds = ALLOC(uint8_t, NH); fillB(wireEnds, 0, NH);
  donated = ALLOC(uint8_t, NH); fillB(donated, 0, NH);
  sharedPen = ALLOC(uint8_t, NH); fillB(sharedPen, 0, NH);
  colSlot = ALLOC(i32, C); colSlotGen = ALLOC(i32, C); fillI(colSlotGen, 0, C); colGen = 0;
  bSlot = ALLOC(i32, C); bSlotGen = ALLOC(i32, C); fillI(bSlotGen, 0, C); bGen = 0;
  cmN = (Vec){0}; cmFirst = (Vec){0}; cmCol = (Vec){0}; cmRowStart = (Vec){0}; cmRowCnt = (Vec){0}; cmRows = (Vec){0};

  // segment at each hole (the first in index order) and its group
  segAt = ALLOC(i32, NH); fillI(segAt, -1, NH);
  for (i32 si = nSeg - 1; si >= 0; si--)
    for (i32 c = segStart[si]; c <= segEnd[si]; c++) segAt[segRow[si] * C + c] = si;
  segToGroup = ALLOC(i32, nSeg + 1); fillI(segToGroup, -1, nSeg + 1);
  for (i32 gi = 0; gi < nGroups; gi++)
    for (i32 k = gSegStart[gi]; k < gSegStart[gi + 1]; k++) segToGroup[gSegIdx[k]] = gi;

  // free holes per group
  i32 total = 0;
  for (i32 k = 0; k < nGroupIdx; k++) total += segEnd[gSegIdx[k]] - segStart[gSegIdx[k]] + 1;
  freeH = ALLOC(i32, total + 1);
  gFreeStart = ALLOC(i32, nGroups + 1); gFreeCnt = ALLOC(i32, nGroups + 1);
  i32 nf = 0;
  for (i32 gi = 0; gi < nGroups; gi++) {
    gFreeStart[gi] = nf;
    for (i32 k = gSegStart[gi]; k < gSegStart[gi + 1]; k++) {
      i32 si = gSegIdx[k];
      for (i32 c = segStart[si]; c <= segEnd[si]; c++)
        if (!occ[segRow[si] * C + c]) freeH[nf++] = segRow[si] * C + c;
    }
    gFreeCnt[gi] = nf - gFreeStart[gi];
  }

  // groups per net in pin order, and pins per group
  ngStart = ALLOC(i32, nNetIds + 1); ngCnt = ALLOC(i32, nNetIds + 1);
  fillI(ngStart, 0, nNetIds + 1); fillI(ngCnt, 0, nNetIds + 1);
  i32 *pinGroup = ALLOC(i32, nPins + 1);
  for (i32 i = 0; i < nPins; i++) {
    i32 si = segAt[pinRow[i] * C + pinCol[i]];
    pinGroup[i] = si >= 0 ? segToGroup[si] : -1;
    if (pinNet[i] >= 0 && pinGroup[i] >= 0) ngStart[pinNet[i] + 1]++;
  }
  for (i32 n = 0; n < nNetIds; n++) ngStart[n + 1] += ngStart[n];
  ngList = ALLOC(i32, ngStart[nNetIds] + 1);
  for (i32 i = 0; i < nPins; i++) {
    i32 n = pinNet[i], gi = pinGroup[i];
    if (n < 0 || gi < 0) continue;
    i32 dup = 0;
    for (i32 k = 0; k < ngCnt[n]; k++) if (ngList[ngStart[n] + k] == gi) { dup = 1; break; }
    if (!dup) ngList[ngStart[n] + ngCnt[n]++] = gi;
  }
  gpStart = ALLOC(i32, nGroups + 1); gpCnt = ALLOC(i32, nGroups + 1);
  fillI(gpStart, 0, nGroups + 1); fillI(gpCnt, 0, nGroups + 1);
  for (i32 i = 0; i < nPins; i++) if (pinGroup[i] >= 0) gpStart[pinGroup[i] + 1]++;
  for (i32 gi = 0; gi < nGroups; gi++) gpStart[gi + 1] += gpStart[gi];
  gpH = ALLOC(i32, nPins + 1);
  for (i32 i = 0; i < nPins; i++) {
    i32 gi = pinGroup[i];
    if (gi >= 0) gpH[gpStart[gi] + gpCnt[gi]++] = pinRow[i] * C + pinCol[i];
  }

  // Wire ends do not consume holes (same-net wires may chain on one hole), so
  // the only coupling between nets is collinear overlap: whichever net routes
  // first takes the clean straight paths. Nets with the fewest free holes
  // (fewest options) route first, a stable sort; nets with room can detour.
  i32 *order = ALLOC(i32, nRoute + 1), nOrder = 0;
  double *supply = ALLOC(double, nRoute + 1);
  for (i32 n = 0; n < nRoute; n++) {
    if (ngCnt[n] == 0) continue;
    i32 s = 0;
    for (i32 k = 0; k < ngCnt[n]; k++) s += gFreeCnt[ngList[ngStart[n] + k]];
    supply[n] = s;
    order[nOrder++] = n;
  }
  for (i32 i = 1; i < nOrder; i++) {
    i32 x = order[i], j = i - 1;
    while (j >= 0 && supply[order[j]] > supply[x]) { order[j + 1] = order[j]; j--; }
    order[j + 1] = x;
  }

  // Relay strips: copper a net may claim to travel sideways between two
  // vertical hop wires, the human way to avoid a long slanted wire. Pin-free
  // groups come as they are; the free tail of a used segment is donated at
  // the price of one cut severing it from the donor's pins (in drilled mode
  // the tail hole beside the pins is drilled out instead, so the break is a
  // drill and the rest of the tail stays usable). A claimed relay belongs to
  // its net for the rest of the pass.
  candCap = 3 * (nGroups + 2 * nSeg) + 16;
  cHStart = ALLOC(i32, candCap); cHCnt = ALLOC(i32, candCap); cSStart = ALLOC(i32, candCap); cSCnt = ALLOC(i32, candCap);
  cByCol = ALLOC(i32, candCap); cHasCut = ALLOC(i32, candCap); cCutRow = ALLOC(i32, candCap); cCutCol = ALLOC(i32, candCap);
  cCutKind = ALLOC(i32, candCap); cDonorGroup = ALLOC(i32, candCap); cDonorNet = ALLOC(i32, candCap);
  cDonorNeedy = ALLOC(i32, candCap); cSplit = ALLOC(i32, candCap); cOwner = ALLOC(i32, candCap);
  cHoles = (Vec){0}; cSet = (Vec){0}; owned = (Vec){0}; tmpHoles = (Vec){0};
  nCand = 0;
  if (!skipRelays) {
    for (i32 gi = 0; gi < nGroups; gi++) {
      if (gpCnt[gi] > 0 || gFreeCnt[gi] == 0) continue;
      addCand(freeH + gFreeStart[gi], gFreeCnt[gi], -1, 0, 0, 0, 0, -1, -2, 0);
    }
    i32 *colSeen = ALLOC(i32, C), colSeenGen = 0;
    fillI(colSeen, 0, C);
    for (i32 si = 0; si < nSeg; si++) {
      i32 gi = segToGroup[si];
      if (gi < 0) continue;
      i32 row = segRow[si], nSegPins = 0, pinMin = FAR, pinMax = -FAR;
      // distinct net values of the segment's pins: -1 stands for null
      i32 net0 = -3, nNetVals = 0;
      for (i32 i = 0; i < nPins; i++) {
        if (pinRow[i] != row || pinCol[i] < segStart[si] || pinCol[i] > segEnd[si]) continue;
        nSegPins++;
        if (pinCol[i] < pinMin) pinMin = pinCol[i];
        if (pinCol[i] > pinMax) pinMax = pinCol[i];
        if (nNetVals == 0) { net0 = pinNet[i]; nNetVals = 1; }
        else if (pinNet[i] != net0) nNetVals = 2;
      }
      if (nSegPins == 0 || nNetVals != 1) continue;
      i32 donorNet = net0;
      i32 donorNeedy = (donorNet >= 0 && ngCnt[donorNet] > 1) || (donorNet >= 0 && reserve[donorNet]);
      for (i32 side = 0; side < 2; side++) {
        i32 drillCol = side == 0 ? pinMin - 1 : pinMax + 1;
        if (drill && (drillCol < segStart[si] || drillCol > segEnd[si] || pinHole[row * C + drillCol])) continue;
        i32 beyond = drill ? drillCol : side == 0 ? pinMin : pinMax;
        tmpHoles.n = 0;
        i32 gen = ++colSeenGen, distinct = 0;
        for (i32 k = 0; k < gFreeCnt[gi]; k++) {
          i32 h = freeH[gFreeStart[gi] + k], hr = h / C, hc = h % C;
          if (hr != row || hc < segStart[si] || hc > segEnd[si]) continue;
          if (side == 0 ? !(hc < beyond) : !(hc > beyond)) continue;
          vpush(&tmpHoles, h);
          if (colSeen[hc] != gen) { colSeen[hc] = gen; distinct++; }
        }
        if (distinct < 2) continue;
        i32 *holes = ALLOC(i32, tmpHoles.n + 1);
        for (i32 k = 0; k < tmpHoles.n; k++) holes[k] = tmpHoles.a[k];
        addCand(holes, tmpHoles.n, drill ? row * C + drillCol : -1, 1, row,
                drill ? drillCol : side == 0 ? pinMin - 1 : pinMax, drill ? 1 : 0, gi, donorNet, donorNeedy);
      }
    }
  }
  if (nCand > MAX_RELAY_CANDS) {
    // keep the free groups and the widest tails (stable by column count)
    i32 *keep = ALLOC(i32, nCand), nk = 0, nFree = 0;
    for (i32 ci = 0; ci < nCand; ci++) if (!cHasCut[ci]) { keep[nk++] = ci; nFree++; }
    i32 *tails = ALLOC(i32, nCand), nt = 0;
    for (i32 ci = 0; ci < nCand; ci++) if (cHasCut[ci]) tails[nt++] = ci;
    for (i32 i = 1; i < nt; i++) {
      i32 x = tails[i], j = i - 1;
      while (j >= 0 && cmN.a[cByCol[tails[j]]] < cmN.a[cByCol[x]]) { tails[j + 1] = tails[j]; j--; }
      tails[j + 1] = x;
    }
    i32 room = imax(0, MAX_RELAY_CANDS - nFree);
    for (i32 i = 0; i < nt && i < room; i++) keep[nk++] = tails[i];
    // compact the candidate arrays in the kept order
    i32 *tmp = ALLOC(i32, nk + 1);
    i32 *arrs[] = {cHStart, cHCnt, cSStart, cSCnt, cByCol, cHasCut, cCutRow, cCutCol, cCutKind, cDonorGroup, cDonorNet, cDonorNeedy, cSplit, cOwner};
    for (u32 a = 0; a < sizeof(arrs) / sizeof(arrs[0]); a++) {
      for (i32 i = 0; i < nk; i++) tmp[i] = arrs[a][keep[i]];
      for (i32 i = 0; i < nk; i++) arrs[a][i] = tmp[i];
    }
    nCand = nk;
  }
  w1State = ALLOC(uint8_t, candCap);
  w1Hop = ALLOC(Hop, candCap);

  // pass state
  i32 wCap = nExist + 2 * nPins + 2 * nGroups + 16;
  wFr = ALLOC(i32, wCap); wFc = ALLOC(i32, wCap); wTr = ALLOC(i32, wCap); wTc = ALLOC(i32, wCap);
  ivLo = ALLOC(i32, 2 * wCap); ivHi = ALLOC(i32, 2 * wCap);
  stCol = ALLOC(Vec, C); stRow = ALLOC(Vec, R);
  for (i32 c = 0; c < C; c++) stCol[c] = (Vec){0};
  for (i32 r = 0; r < R; r++) stRow[r] = (Vec){0};
  stSlant = (Vec){0};
  nW = 0;
  for (i32 i = 0; i < nExist; i++) {
    i32 w = nW++;
    wFr[w] = exist[4 * i]; wFc[w] = exist[4 * i + 1]; wTr[w] = exist[4 * i + 2]; wTc[w] = exist[4 * i + 3];
    stackAdd(w);
    wireEnds[wFr[w] * C + wFc[w]] = 1;
    wireEnds[wTr[w] * C + wTc[w]] = 1;
  }
  epStart = ALLOC(i32, nGroups + 1); epCnt = ALLOC(i32, nGroups + 1); epDone = ALLOC(i32, nGroups + 1);
  fillI(epDone, 0, nGroups + 1);
  epPool = (Vec){0};
  bcHandle = ALLOC(i32, nGroups + 1); bcGen = ALLOC(i32, nGroups + 1); fillI(bcGen, 0, nGroups + 1); bcEpoch = 1;
  conRow = ALLOC(Vec, R);
  for (i32 r = 0; r < R; r++) conRow[r] = (Vec){0};
  conTouched = (Vec){0}; conCols = (Vec){0}; conNodeRow = (Vec){0}; conNodeNext = (Vec){0};
  conHead = ALLOC(i32, C); conTail = ALLOC(i32, C); conSeen = ALLOC(i32, C); fillI(conSeen, 0, C); conGen = 0;
  remAlive = ALLOC(i32, nGroups + 1); fillI(remAlive, 0, nGroups + 1); remGen = 0;
  remList = (Vec){0};
  outWires = (Vec){0}; outCuts = (Vec){0}; outEv = (Vec){0}; outEvPins = (Vec){0};
  passMess = 0;
  sharedJoints = 0;
  allowDeepStacks = 0;

  for (i32 oi = 0; oi < nOrder; oi++) {
    i32 net = order[oi];
    curNet = net;
    // fresh connected copper for this net
    for (i32 k = 0; k < conTouched.n; k++) conRow[conTouched.a[k]].n = 0;
    conTouched.n = 0; conCols.n = 0; conNodeRow.n = 0; conNodeNext.n = 0;
    conGen++;
    connMinRow = FAR; connMaxRow = -FAR;
    remGen++;
    remList.n = 0;
    remCount = 0;
    i32 first = ngList[ngStart[net]];
    for (i32 k = 1; k < ngCnt[net]; k++) {
      i32 gi = ngList[ngStart[net] + k];
      vpush(&remList, gi);
      remAlive[gi] = remGen;
      remCount++;
    }
    if (remCount > 0) {
      endpointsOf(first);
      for (i32 k = 0; k < epCnt[first]; k++) {
        i32 h = epPool.a[epStart[first] + k];
        if (!donated[h]) addConnected(h);
      }
    }
    while (remCount > 0) {
      Choice best;
      Relay relay;
      i32 hasBest, hasRelay = search(&best, &hasBest, &relay);
      if (!hasBest && !hasRelay) {
        allowDeepStacks = 1;
        hasRelay = search(&best, &hasBest, &relay);
        allowDeepStacks = 0;
      }
      if (!hasBest && !hasRelay) {
        starve(0, net);
        break;
      }
      if (hasRelay && (!hasBest || relay.cost < best.cost - best.shared - 1e-9)) {
        i32 ci = relay.relay;
        if (cOwner[ci] < 0 && cHasCut[ci]) {
          vpush(&outCuts, cCutRow[ci]); vpush(&outCuts, cCutCol[ci]); vpush(&outCuts, cCutKind[ci]);
          for (i32 k = 0; k < cSCnt[ci]; k++) donated[cSet.a[cSStart[ci] + k]] = 1;
          bcEpoch++;
        }
        pushWire(relay.w1.fr, relay.w1.fc, relay.w1.tr, relay.w1.tc);
        pushWire(relay.w2.fr, relay.w2.fc, relay.w2.tr, relay.w2.tc);
        passMess += relay.mess;
        if (cOwner[ci] < 0) vpush(&owned, ci);
        cOwner[ci] = net;
        remAlive[relay.group] = 0;
        remCount--;
        for (i32 k = 0; k < cHCnt[ci]; k++) addConnected(cHoles.a[cHStart[ci] + k]);
        endpointsOf(relay.group);
        for (i32 k = 0; k < epCnt[relay.group]; k++) {
          i32 h = epPool.a[epStart[relay.group] + k];
          if (!donated[h]) addConnected(h);
        }
        continue;
      }
      pushWire(best.fr, best.fc, best.tr, best.tc);
      passMess += best.mess;
      remAlive[best.group] = 0;
      remCount--;
      endpointsOf(best.group);
      for (i32 k = 0; k < epCnt[best.group]; k++) {
        i32 h = epPool.a[epStart[best.group] + k];
        if (!donated[h]) addConnected(h);
      }
    }

    // strict bus rows: a claimed blank strip keeps the span its wires use and
    // offers the copper beyond either end to later nets as relay tails
    if (strict) {
      for (i32 oc = 0; oc < owned.n; oc++) {
        i32 ci = owned.a[oc];
        if (cOwner[ci] != net || cHasCut[ci] || cSplit[ci]) continue;
        cSplit[ci] = 1;
        i32 row = cHoles.a[cHStart[ci]] / C, oneRow = 1;
        for (i32 k = 0; k < cHCnt[ci]; k++) if (cHoles.a[cHStart[ci] + k] / C != row) { oneRow = 0; break; }
        if (!oneRow) continue;
        i32 minC = FAR, maxC = -FAR;
        for (i32 w = nExist; w < nW; w++) {
          for (i32 e = 0; e < 2; e++) {
            i32 r = e ? wTr[w] : wFr[w], c = e ? wTc[w] : wFc[w];
            if (!inSet(ci, r * C + c)) continue;
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
          }
        }
        if (minC == FAR) continue;
        for (i32 side = 0; side < 2; side++) {
          i32 sacrificed = side == 0 ? minC - 1 : maxC + 1;
          tmpHoles.n = 0;
          i32 gen = ++colGen, distinct = 0;
          for (i32 k = 0; k < cHCnt[ci]; k++) {
            i32 h = cHoles.a[cHStart[ci] + k], hc = h % C;
            int keep = drill ? (side == 0 ? hc < sacrificed : hc > sacrificed) : (side == 0 ? hc < minC : hc > maxC);
            if (!keep) continue;
            vpush(&tmpHoles, h);
            if (colSlotGen[hc] != gen) { colSlotGen[hc] = gen; distinct++; }
          }
          if (distinct < 2) continue;
          if (drill && !(sacrificed >= 0 && sacrificed < C && inSet(ci, row * C + sacrificed))) continue;
          i32 *holes = ALLOC(i32, tmpHoles.n + 1);
          for (i32 k = 0; k < tmpHoles.n; k++) holes[k] = tmpHoles.a[k];
          addCand(holes, tmpHoles.n, drill ? row * C + sacrificed : -1, 1, row,
                  drill ? sacrificed : side == 0 ? minC - 1 : maxC, drill ? 1 : 0, -1, net, 0);
        }
      }
    }

    // nets that still await unplaced parts must keep a free hole
    if (reserve[net]) {
      i32 hasFree = 0;
      for (i32 k = 0; k < ngCnt[net] && !hasFree; k++) {
        i32 gi = ngList[ngStart[net] + k];
        for (i32 j = 0; j < gFreeCnt[gi]; j++) if (!donated[freeH[gFreeStart[gi] + j]]) { hasFree = 1; break; }
      }
      if (!hasFree) starve(1, net);
    }
  }

  outMess = passMess;
  outHdr = ALLOC(i32, 12);
  double *messOut = ALLOC(double, 1);
  *messOut = outMess;
  outHdr[0] = outWires.n / 4;
  outHdr[1] = JSPTR(outWires.a);
  outHdr[2] = outCuts.n / 3;
  outHdr[3] = JSPTR(outCuts.a);
  outHdr[4] = sharedJoints;
  outHdr[5] = outEv.n / 4;
  outHdr[6] = JSPTR(outEv.a);
  outHdr[7] = JSPTR(outEvPins.a);
  outHdr[8] = JSPTR(messOut);
  return outHdr;
}
