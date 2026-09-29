// The v5 decoder and anneal loop in C for WebAssembly: genome in, exact board
// measurement out. It was ported line by line from the TypeScript decoder it
// replaced (same order of floating-point operations, Math.pow and Math.exp
// imported from JavaScript) and verified to give the same numbers on every
// proposal; the explainer's walkthrough is recorded from its trace.
//
// Build: npm run build:wasm (clang --target=wasm32 with 128-bit SIMD, which every
// browser since Chrome 91, Firefox 89 and Safari 16.4 runs; no libc) into v5decode.wasm
// beside this file, which is committed: the app build needs no clang. Memory is one
// bump arena: v5_reset() empties it, v5_init() lays out the model the
// TypeScript side wrote, working buffers are taken from it on demand.

#include <stdint.h>

typedef int32_t i32;
typedef uint32_t u32;

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

EXPORT(v5_reset) void v5_reset(void) { heapTop = ARENA_START; }
EXPORT(v5_alloc) void *v5_alloc(i32 bytes) { return balloc((u32)bytes); }

static void fillI(i32 *a, i32 v, i32 n) { for (i32 i = 0; i < n; i++) a[i] = v; }
static void fillD(double *a, double v, i32 n) { for (i32 i = 0; i < n; i++) a[i] = v; }
static void fillB(uint8_t *a, uint8_t v, i32 n) { for (i32 i = 0; i < n; i++) a[i] = v; }

static inline i32 imax(i32 a, i32 b) { return a > b ? a : b; }
static inline i32 imin(i32 a, i32 b) { return a < b ? a : b; }
static inline i32 iabs(i32 a) { return a < 0 ? -a : a; }
static inline double dmax(double a, double b) { return a > b ? a : b; }
static inline double dmin(double a, double b) { return a < b ? a : b; }
static inline double dabs(double a) { return a < 0 ? -a : a; }
static inline double dfloor(double a) { return __builtin_floor(a); }
static inline double dceil(double a) { return __builtin_ceil(a); }
// Math.round: halves go up
static inline i32 jsRound(double a) { return (i32)__builtin_floor(a + 0.5); }

// ── constants (boardPrice.ts, packageBodies.ts) ──

#define W_AREA 0.35
#define W_WIRE 4.0
#define W_WLEN 0.4
#define W_CUT 0.05
#define W_TALL 2.0
#define W_LOCKOVER 150.0
#define W_SIBLING 0.5
#define CONN_FULL 30.0
#define MM_PER_HOLE 2.54
#define BEND 0.5

// sides: 0 left, 1 right, 2 top, 3 bottom (mask bits in that order)
enum { SH_OTHER = 0, SH_AXIAL = 1, SH_CAN = 2, SH_LED = 3 };

// ── model (written by the TypeScript side, v5Wasm.ts serialize) ──

static i32 nP, nNets, nFlex, nRigid, mRow, mCol, lockRowsCap, lockColsCap, sidesDef, nNP, clrPad, maxNet, maxK, nSib;
static double wBCut;
static i32 *pKind, *pLocked, *pIsConn, *pClr, *pLines, *pFat, *pIdx, *pSides, *pLockY0, *pLockY1, *pLockX, *pLockRot, *pShapeBase;
static i32 *fNa, *fNb, *fMinS, *fMaxS, *fCanH, *fDc0, *fVdOff, *fHasSpec, *fShape, *fMark;
static double *fLen, *fR;
static i32 *vdTab;
static i32 *sW, *sH, *sEntry, *sPinStart, *sPinCnt, *sHasReach;
static double *sBody, *sReach;
static i32 *spRow, *spCol, *spNet;
static i32 *npStart, *npPi, *npKind, *npEnd, *npPinIdx;
static i32 *flexList, *rigidList;
static i32 *sgStart, *sgPi;

// genome, reference board and results: shared with the TypeScript side
static i32 *gGp, *gGn, *gRot, *gHv, *gBr, *gGap, *gXgap, *gGrp;
static i32 *refHdr, *refYI, *refXI, *refKey, *refBr; // refHdr: valid, nNode
// the anneal's current genome (the proposal is built in the g* block), the
// current board's measurement (outI/outD layout) and the loop's state
static i32 *cGp, *cGn, *cRot, *cHv, *cBr, *cGap, *cXgap, *cGrp, *curI, *loopI;
static double *curD, *loopD;
static i32 nConns, *conns, nPull, *pullStart, *pullPi, *pullNet, *halfTurn, *canHV, nRotK, *rotK;
static i32 *outI, *outYI, *outXI, *outKey;
static double *outD;

// strip-group protection (autoLayout5 protectTies): a tie the orders
// contradict refuses the proposal instead of splitting the pin off
static double strictTies = 0;
static u32 strictState = 0;
static double strictRand(void) {
  strictState = strictState + 0x6d2b79f5u;
  u32 a = strictState;
  u32 t = (a ^ (a >> 15)) * (1u | a);
  t = (t + (t ^ (t >> 7)) * (61u | t)) ^ t;
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}
// the kind of the proposal being decoded (mutate). A rotation may always
// split a tie: two pins of one part tied to one strip contradict every turn
// of that part, and protection would pin its orientation for good (measured
// 2026-09-29: a module stuck flat with its inner pins unreachable in 18 of
// 32 seeds of a 14-pin board, and in every unsplit seed of a 242-pin one).
static i32 mvKind;
static int refuseSplit(void) { return strictTies > 0 && mvKind != 5 && (strictTies >= 1 || strictRand() < strictTies); }

// ── working buffers ──

static i32 maxE, maxNode;
static i32 *rotOf, *posP, *posN, *geoW, *geoH, *geoMode, *geoShape, *vBotArr, *vBotOf, *nodePart;
static i32 *eU, *eV, *rU, *rV, *rRank, *rE, *ordBuf, *rankCnt, *xU, *xV;
static double *eW, *rW, *xW;
static i32 *rankOf, *walkSeen, *parent, *poff, *lastNet, *lastK, *rootArr, *offArr, *pred;
static double *dist, *xd;
static i32 *lockN, *lockV;
static i32 walkStamp = 0;

// ── board export and trace (the finish and the explainer; off in the anneal) ──
// exOn: the decoded board the way the TypeScript lab board lists it:
// segments (row, c1, c2, net; bus rows and relay spans included), cuts (row,
// col, 0 drilled / 1 knife, the column of the pin that forced it) and wires
// (r1, c1, r2, c2, net, slanted, crossings), each in the order they arise.
// trOn: the decoder's steps as events for the explainer's walkthrough
// (autoLayout5.ts labWalk turns them into frames), each a code and its values.
typedef struct { i32 *a; i32 n, cap; } IVec;
typedef struct { double *a; i32 n, cap; } DVec;
static void ipush(IVec *v, i32 x) {
  if (v->n == v->cap) {
    i32 nc = v->cap ? 2 * v->cap : 256;
    i32 *na = ALLOC(i32, nc);
    for (i32 i = 0; i < v->n; i++) na[i] = v->a[i];
    v->a = na;
    v->cap = nc;
  }
  v->a[v->n++] = x;
}
static void dpush(DVec *v, double x) {
  if (v->n == v->cap) {
    i32 nc = v->cap ? 2 * v->cap : 1024;
    double *na = ALLOC(double, nc);
    for (i32 i = 0; i < v->n; i++) na[i] = v->a[i];
    v->a = na;
    v->cap = nc;
  }
  v->a[v->n++] = x;
}
static i32 exOn, trOn;
static IVec exSeg, exCut, exWire;
static DVec tr;
static void exSegAdd(i32 row, i32 c1, i32 c2, i32 net) { ipush(&exSeg, row); ipush(&exSeg, c1); ipush(&exSeg, c2); ipush(&exSeg, net); }
static void exCutAdd(i32 row, i32 col, i32 knife, i32 pinC) { ipush(&exCut, row); ipush(&exCut, col); ipush(&exCut, knife); ipush(&exCut, pinC); }
static void exWireAdd(i32 r1, i32 c1, i32 r2, i32 c2, i32 net, i32 slanted, i32 crossings) {
  ipush(&exWire, r1); ipush(&exWire, c1); ipush(&exWire, r2); ipush(&exWire, c2);
  ipush(&exWire, net); ipush(&exWire, slanted); ipush(&exWire, crossings);
}
static void trp(double x) { dpush(&tr, x); }
// trace events (labWalk reads the same codes)
enum {
  TR_EDGES = 1,    // nE, then (u, v, w) per y edge
  TR_ATTEMPT,      // a fresh union-find pass
  TR_TIE_SPLIT,    // net, k, u, offU, v, offV: a tie that cannot hold, pin k split off
  TR_TIE_OK,       // net, u, offU, v, offV: a tie the distance already fits
  TR_TIE_JOIN,     // net, u, offU, v, offV, rows v's top sits below u's
  TR_ROOTS,        // the union-find root of every node
  TR_CONFLICT,     // u, v, w, offU, offV: an edge the ties contradict
  TR_CONFLICT_SPLIT, // net, k
  TR_RELAX,        // y edge, then every node's row
  TR_SWEEP,        // sweep index, then every node's row
  TR_CYCLE_SPLIT,  // net, k
  TR_Y_DONE,       // every node's row
  TR_X_START,      // nX, then (u, v, w) per x edge
  TR_X_RELAX,      // x edge, then every part's column (and the source's)
  TR_X_DONE,
  TR_NET,          // net, its segment count
  TR_RELAY,        // a relay link (its wires and span are the next export entries)
  TR_STRAIGHT,     // a straight link: nMarks, then (column, ok) per mark
  TR_SLANT,        // a slanted link
  TR_STARVED,      // net
};
EXPORT(v5_setExport) void v5_setExport(i32 ex, i32 trace) { exOn = ex || trace; trOn = trace; }
// per net and segment
static i32 *netSegCnt, *segLastBuf, *netOrder, *netFirst, *segNext, *segRow, *segC1, *segC2, *segNetOf;
static i32 *kA, *kCross, *kLen, *kCol, *kRow, *kCA, *kCB, *linkCount, *tree, *sIdx;
static double *kTotal;
static uint8_t *kOff, *inTree;
static i32 *clHead, *clNext, *clC1, *clC2, *clNet, clN;
// clearance rects
static i32 *rcPi, *rcKind, *rcOrd, *rcTmp;
static double *rcMinR, *rcMaxR, *rcMinC, *rcMaxC, *rcBody, *rcReach, *rcCap, *rcP, *rcCB, *rcPB;
static i32 *rcHasReach;
static i32 *lbR1, *lbR2, *lbC1, *lbC2;
// grid, grown on demand
static i32 gridCap = 0, rowCap = 0, hopCap = 0;
static int8_t *occ;
static i32 *owner, *pinNetAt, *bodyPre, *rowPinC, *rowPinN, *busRows, *hopCache;
static uint8_t *used;
static u32 *freeM, *usedM;

static i32 rd;
static i32 *M;
static double *F;
static i32 ri(void) { return M[rd++]; }
static i32 *rarr(i32 n) {
  i32 *a = ALLOC(i32, n > 0 ? n : 1);
  for (i32 i = 0; i < n; i++) a[i] = M[rd++];
  return a;
}
static i32 fd;
static double *rdarr(i32 n) {
  double *a = ALLOC(double, n > 0 ? n : 1);
  for (i32 i = 0; i < n; i++) a[i] = F[fd++];
  return a;
}

// Lays out the model the TypeScript side wrote (ints at mi, doubles at md)
// and returns the address of the shared block: genome, reference, results.
static i32 *exHdr;
EXPORT(v5_init) i32 *v5_init(i32 *mi, double *md) {
  M = mi; F = md; rd = 0; fd = 0;
  nP = ri(); nNets = ri(); nFlex = ri(); nRigid = ri(); mRow = ri(); mCol = ri();
  lockRowsCap = ri(); lockColsCap = ri(); sidesDef = ri(); nNP = ri(); clrPad = ri(); maxNet = ri(); maxK = ri(); nSib = ri();
  i32 nShapes = ri(), nShapePins = ri(), nVd = ri(), nSibPi = ri();
  wBCut = F[fd++];
  pKind = rarr(nP); pLocked = rarr(nP); pIsConn = rarr(nP); pClr = rarr(nP); pLines = rarr(nP); pFat = rarr(nP);
  pIdx = rarr(nP); pSides = rarr(nP); pLockY0 = rarr(nP); pLockY1 = rarr(nP); pLockX = rarr(nP); pLockRot = rarr(nP); pShapeBase = rarr(nP);
  fNa = rarr(nP); fNb = rarr(nP); fMinS = rarr(nP); fMaxS = rarr(nP); fCanH = rarr(nP); fDc0 = rarr(nP);
  fVdOff = rarr(nP); fHasSpec = rarr(nP); fShape = rarr(nP); fMark = rarr(nP);
  fLen = rdarr(nP); fR = rdarr(nP);
  vdTab = rarr(nVd);
  sW = rarr(nShapes); sH = rarr(nShapes); sEntry = rarr(nShapes); sPinStart = rarr(nShapes); sPinCnt = rarr(nShapes); sHasReach = rarr(nShapes);
  sBody = rdarr(4 * nShapes); sReach = rdarr(4 * nShapes);
  spRow = rarr(nShapePins); spCol = rarr(nShapePins); spNet = rarr(nShapePins);
  npStart = rarr(nNets + 1); npPi = rarr(nNP); npKind = rarr(nNP); npEnd = rarr(nNP); npPinIdx = rarr(4 * nNP);
  flexList = rarr(nFlex); rigidList = rarr(nRigid);
  sgStart = rarr(nSib + 1); sgPi = rarr(nSibPi);
  // the moves (mutate): throwable connectors, nets whose parts a pull can
  // bring together (and which net each is), half-turn-only rigid parts, flex
  // parts that can lie both ways, rigid parts a rotation can change
  nConns = ri(); conns = rarr(nConns);
  nPull = ri(); pullStart = rarr(nPull + 1); pullPi = rarr(pullStart[nPull]); pullNet = rarr(nPull);
  halfTurn = rarr(nRigid); canHV = rarr(nFlex);
  nRotK = ri(); rotK = rarr(nRotK);

  maxNode = nP + nFlex + 1;
  maxE = nP + nFlex + 1 + 2 * nFlex + (nP * nP + 1) / 2 + 2 * nP + 8;
  rotOf = ALLOC(i32, nP); posP = ALLOC(i32, nP); posN = ALLOC(i32, nP);
  geoW = ALLOC(i32, nP); geoH = ALLOC(i32, nP); geoMode = ALLOC(i32, nP); geoShape = ALLOC(i32, nP);
  vBotArr = ALLOC(i32, nP); vBotOf = ALLOC(i32, nP); nodePart = ALLOC(i32, maxNode);
  eU = ALLOC(i32, maxE); eV = ALLOC(i32, maxE); eW = ALLOC(double, maxE);
  rU = ALLOC(i32, maxE); rV = ALLOC(i32, maxE); rW = ALLOC(double, maxE); rRank = ALLOC(i32, maxE); rE = ALLOC(i32, maxE);
  ordBuf = ALLOC(i32, maxE); rankCnt = ALLOC(i32, 2 * nP + 4);
  xU = ALLOC(i32, maxE); xV = ALLOC(i32, maxE); xW = ALLOC(double, maxE);
  rankOf = ALLOC(i32, maxNode); walkSeen = ALLOC(i32, maxNode); fillI(walkSeen, 0, maxNode); walkStamp = 0;
  parent = ALLOC(i32, maxNode); poff = ALLOC(i32, maxNode); lastNet = ALLOC(i32, maxNode); lastK = ALLOC(i32, maxNode);
  rootArr = ALLOC(i32, maxNode); offArr = ALLOC(i32, maxNode); pred = ALLOC(i32, maxNode);
  dist = ALLOC(double, maxNode); xd = ALLOC(double, nP + 1);
  lockN = ALLOC(i32, maxNode); lockV = ALLOC(i32, maxNode);
  netSegCnt = ALLOC(i32, maxNet); segLastBuf = ALLOC(i32, maxNet); netOrder = ALLOC(i32, maxNet); netFirst = ALLOC(i32, maxNet);
  i32 maxSeg = maxNet + 4;
  segNext = ALLOC(i32, maxSeg); segRow = ALLOC(i32, maxSeg); segC1 = ALLOC(i32, maxSeg); segC2 = ALLOC(i32, maxSeg); segNetOf = ALLOC(i32, maxSeg);
  kA = ALLOC(i32, maxK); kCross = ALLOC(i32, maxK); kLen = ALLOC(i32, maxK); kCol = ALLOC(i32, maxK); kRow = ALLOC(i32, maxK);
  kCA = ALLOC(i32, maxK); kCB = ALLOC(i32, maxK); linkCount = ALLOC(i32, maxK); tree = ALLOC(i32, maxK); sIdx = ALLOC(i32, maxK);
  kTotal = ALLOC(double, maxK); kOff = ALLOC(uint8_t, maxK); inTree = ALLOC(uint8_t, maxK);
  clNext = ALLOC(i32, maxSeg); clC1 = ALLOC(i32, maxSeg); clC2 = ALLOC(i32, maxSeg); clNet = ALLOC(i32, maxSeg);
  rcPi = ALLOC(i32, nP); rcKind = ALLOC(i32, nP); rcOrd = ALLOC(i32, nP); rcTmp = ALLOC(i32, nP); rcHasReach = ALLOC(i32, nP);
  rcMinR = ALLOC(double, nP); rcMaxR = ALLOC(double, nP); rcMinC = ALLOC(double, nP); rcMaxC = ALLOC(double, nP);
  rcBody = ALLOC(double, 4 * nP); rcReach = ALLOC(double, 4 * nP); rcCap = ALLOC(double, 5 * nP); rcP = ALLOC(double, 4 * nP);
  rcCB = ALLOC(double, 4 * nP); rcPB = ALLOC(double, 4 * nP);
  lbR1 = ALLOC(i32, nP); lbR2 = ALLOC(i32, nP); lbC1 = ALLOC(i32, nP); lbC2 = ALLOC(i32, nP);
  gridCap = rowCap = hopCap = 0;

  // shared block: header of addresses the TypeScript side reads its views from
  i32 *hdr = ALLOC(i32, 32);
  cGp = ALLOC(i32, nP); cGn = ALLOC(i32, nP); cRot = ALLOC(i32, nRigid); cHv = ALLOC(i32, nFlex); cBr = ALLOC(i32, nFlex);
  cGap = ALLOC(i32, nP); cXgap = ALLOC(i32, nP); cGrp = ALLOC(i32, nNP);
  curI = ALLOC(i32, 32); curD = ALLOC(double, 8); loopI = ALLOC(i32, 8); loopD = ALLOC(double, 8);
  gGp = ALLOC(i32, nP); gGn = ALLOC(i32, nP); gRot = ALLOC(i32, nRigid); gHv = ALLOC(i32, nFlex); gBr = ALLOC(i32, nFlex);
  gGap = ALLOC(i32, nP); gXgap = ALLOC(i32, nP); gGrp = ALLOC(i32, nNP);
  refHdr = ALLOC(i32, 2); refYI = ALLOC(i32, maxNode); refXI = ALLOC(i32, nP); refKey = ALLOC(i32, nP); refBr = ALLOC(i32, nFlex);
  outI = ALLOC(i32, 32); outD = ALLOC(double, 8); outYI = ALLOC(i32, maxNode); outXI = ALLOC(i32, nP); outKey = ALLOC(i32, nP);
  i32 *list[] = { gGp, gGn, gRot, gHv, gBr, gGap, gXgap, gGrp, refHdr, refYI, refXI, refKey, refBr, outI, (i32 *)outD, outYI, outXI, outKey,
    cGp, cGn, cRot, cHv, cBr, cGap, cXgap, cGrp, curI, (i32 *)curD, loopI, (i32 *)loopD };
  for (i32 i = 0; i < (i32)(sizeof(list) / sizeof(list[0])); i++) hdr[i] = JSPTR(list[i]);
  exHdr = ALLOC(i32, 12);
  return hdr;
}

// per-decode scratch grids, grown on demand and cleared over the used prefix
// only (a fresh allocation per decode was a tenth of the run)
static void ensureGrid(i32 n, i32 gh, i32 gw) {
  if (n > gridCap) {
    gridCap = imax(n, gridCap * 2);
    occ = ALLOC(int8_t, gridCap); owner = ALLOC(i32, gridCap); pinNetAt = ALLOC(i32, gridCap);
    used = ALLOC(uint8_t, gridCap); bodyPre = ALLOC(i32, gridCap);
    freeM = ALLOC(u32, gridCap); usedM = ALLOC(u32, gridCap);
  }
  i32 rc = imax(gh, gw) + 1;
  if (rc > rowCap) {
    rowCap = imax(rc, rowCap * 2);
    rowPinC = ALLOC(i32, rowCap); rowPinN = ALLOC(i32, rowCap); busRows = ALLOC(i32, rowCap); clHead = ALLOC(i32, rowCap);
  }
}

// ── geometry (flexGeometry.ts, partGeometry.ts) ──

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
static double clearanceAir(i32 lines) { return lines > 0 ? lines - 0.5 : 0; }
// capsule: [ar, ac, br, bc, r]
static int capsulesClash(const double *A, const double *B, i32 lines) {
  return segmentSegmentDistance(A[0], A[1], A[2], A[3], B[0], B[1], B[2], B[3]) < A[4] + B[4] + clearanceAir(lines) - 1e-6;
}
// rect: [minRow, maxRow, minCol, maxCol]
static int capsuleClashesRect(const double *A, const double *rect, i32 lines) {
  double reach = A[4] + clearanceAir(lines) - 1e-6;
  double minRow = rect[0] - 0.5, maxRow = rect[1] + 0.5, minCol = rect[2] - 0.5, maxCol = rect[3] + 0.5;
  if ((A[0] > minRow && A[0] < maxRow && A[1] > minCol && A[1] < maxCol) ||
      (A[2] > minRow && A[2] < maxRow && A[3] > minCol && A[3] < maxCol)) return 1;
  return segmentSegmentDistance(A[0], A[1], A[2], A[3], minRow, minCol, minRow, maxCol) < reach ||
         segmentSegmentDistance(A[0], A[1], A[2], A[3], minRow, maxCol, maxRow, maxCol) < reach ||
         segmentSegmentDistance(A[0], A[1], A[2], A[3], maxRow, maxCol, maxRow, minCol) < reach ||
         segmentSegmentDistance(A[0], A[1], A[2], A[3], maxRow, minCol, minRow, minCol) < reach;
}
static int bodyRectsClash(const double *a, const double *b, i32 lines) {
  double air = clearanceAir(lines) - 1e-6;
  return a[0] - air < b[1] + 1 && b[0] - air < a[1] + 1 && a[2] - air < b[3] + 1 && b[2] - air < a[3] + 1;
}
// two boxes [minRow, maxRow, minCol, maxCol] at least d apart along the rows or the columns
static int boxesApart(const double *a, const double *b, double d) {
  return a[0] - b[1] >= d || b[0] - a[1] >= d || a[2] - b[3] >= d || b[2] - a[3] >= d;
}
// flexBody(profile, p1, p2) of flex part pi, into cap[5]
static void flexBody(i32 pi, double p1r, double p1c, double p2r, double p2c, double *cap) {
  double dr = p2r - p1r, dc = p2c - p1c;
  double span = __builtin_sqrt(dr * dr + dc * dc);
  double midR = (p1r + p2r) / 2, midC = (p1c + p2c) / 2;
  double len, r;
  if (!fHasSpec[pi]) {
    len = span; r = 0.5;
  } else {
    r = fR[pi];
    int flat = fShape[pi] != SH_AXIAL || span * MM_PER_HOLE >= fLen[pi] + 2 * BEND;
    if (!flat) {
      int rev = !fMark[pi] && (p2c < p1c || (p2c == p1c && p2r < p1r));
      cap[0] = cap[2] = rev ? p2r : p1r;
      cap[1] = cap[3] = rev ? p2c : p1c;
      cap[4] = r;
      return;
    }
    if (fShape[pi] == SH_CAN || fShape[pi] == SH_LED) {
      cap[0] = cap[2] = midR; cap[1] = cap[3] = midC;
      cap[4] = fShape[pi] == SH_LED ? r * 1.16 : r;
      return;
    }
    len = fLen[pi] / MM_PER_HOLE;
  }
  double half = dmax(0, len / 2 - r);
  cap[4] = r;
  if (span == 0 || half == 0) {
    cap[0] = cap[2] = midR; cap[1] = cap[3] = midC;
    return;
  }
  double ur = (dr / span) * half, uc = (dc / span) * half;
  cap[0] = midR - ur; cap[1] = midC - uc; cap[2] = midR + ur; cap[3] = midC + uc;
}

// ── decode ──

static i32 H, W, GH, GW, overlapBad, floatNet;

static void claim(i32 r, i32 c, i32 v, i32 net, i32 pi) {
  if (r < 0 || c < 0 || r >= H || c >= W) {
    overlapBad++;
    return;
  }
  i32 i = (r + mRow) * GW + c + mCol;
  if (occ[i] != 0 && owner[i] != pi) overlapBad++;
  if (v == 2 || occ[i] == 0) {
    occ[i] = (int8_t)v;
    owner[i] = pi;
    if (v == 2 && net >= 0) pinNetAt[i] = net;
  }
}

static i32 nLockedBoxes;
static int flexCellBad(i32 r, i32 c, int modeV) {
  for (i32 k = 0; k < nLockedBoxes; k++) {
    int inRing = r >= lbR1[k] - 1 && r <= lbR2[k] + 1 && c >= lbC1[k] - 1 && c <= lbC2[k] + 1;
    if (!inRing) continue;
    if (modeV && r >= lbR1[k] && r <= lbR2[k]) return 1;
    if (!modeV && c >= lbC1[k] && c <= lbC2[k]) return 1;
    if (r >= lbR1[k] && r <= lbR2[k] && c >= lbC1[k] && c <= lbC2[k]) return 1;
  }
  return 0;
}

// A body wider than the line between its legs (a can) lies over holes of its
// own: nothing else may use them, and a link through them runs under the
// part. Off the board's edge it simply hangs over.
static void claimBody(i32 pi, i32 r1, i32 c1, i32 r2, i32 c2) {
  if (!pFat[pi]) return;
  double cap[5];
  flexBody(pi, r1, c1, r2, c2, cap);
  double reach = cap[4] - 0.05;
  for (double row = dceil(dmin(cap[0], cap[2]) - reach); row <= dmax(cap[0], cap[2]) + reach; row++) {
    for (double col = dceil(dmin(cap[1], cap[3]) - reach); col <= dmax(cap[1], cap[3]) + reach; col++) {
      if (pointSegmentDistance(row, col, cap[0], cap[1], cap[2], cap[3]) < reach) {
        if (row >= 0 && col >= 0 && row < H && col < W) claim((i32)row, (i32)col, 1, -1, pi);
      }
    }
  }
}

static i32 WPR;
// Cleanest column shared by two rows over [c1, c2]: free and unused on both,
// fewest bodies between; the column plus the body count in the high bits, or
// -1. A column free on two rows is a set bit in the AND of their words, so the
// scan visits only those columns.
static i32 sharedCol(i32 rowA, i32 rowB, i32 c1, i32 c2) {
  i32 wA = rowA * WPR, wB = rowB * WPR;
  i32 preTop = (imin(rowA, rowB) + 1) * GW, preBot = imax(rowA, rowB) * GW;
  i32 bestC = -1, bestCross = 0x7fffffff;
  i32 wLo = c1 >> 5, wHi = c2 >> 5;
  for (i32 w = wLo; w <= wHi; w++) {
    u32 m = freeM[wA + w] & freeM[wB + w] & ~usedM[wA + w] & ~usedM[wB + w];
    if (w == wLo) m &= 0xffffffffu << (c1 & 31);
    if (w == wHi && (c2 & 31) < 31) m &= (1u << ((c2 & 31) + 1)) - 1;
    while (m != 0) {
      u32 low = m & (0u - m);
      m ^= low;
      i32 c = (w << 5) + 31 - __builtin_clz(low);
      i32 cr = bodyPre[preBot + c] - bodyPre[preTop + c];
      if (cr < bestCross) {
        bestCross = cr;
        bestC = c;
      }
      if (cr == 0) return bestC;
    }
  }
  return bestC < 0 ? -1 : bestC + (bestCross << 16);
}

// per-net MST state
static i32 nSeg, nBus, curNet;
static i32 treeN;

static void markUsed(i32 r, i32 c) {
  used[r * GW + c] = 1;
  usedM[r * WPR + (c >> 5)] |= 1u << (c & 31);
}

// hop columns per (segment, bus row), found once and reused while the two
// holes they end on stay free
static i32 hopCached(i32 si, i32 bi2) {
  i32 idx = si * nBus + bi2;
  i32 h = hopCache[idx];
  if (h >= 0) {
    i32 c = h & 0xffff;
    if (used[segRow[sIdx[si]] * GW + c] || used[busRows[bi2] * GW + c]) h = -2;
  }
  if (h == -2) {
    i32 s = sIdx[si];
    h = sharedCol(segRow[s], busRows[bi2], segC1[s], segC2[s]);
    hopCache[idx] = h;
  }
  return h;
}

static void offer(i32 ti, i32 b2, int force) {
  i32 A = sIdx[tree[ti]], B = sIdx[b2];
  i32 lo = imax(segC1[A], segC1[B]), hi = imin(segC2[A], segC2[B]);
  double cost;
  i32 cross = 0, bestCol = -1;
  if (segRow[A] == segRow[B]) cost = 50;
  else if (lo <= hi) {
    i32 h = sharedCol(segRow[A], segRow[B], lo, hi);
    if (h < 0) cost = 50;
    else {
      bestCol = h & 0xffff;
      cross = h >> 16;
      cost = 1 + cross * 8;
    }
  } else cost = 50;
  i32 len = iabs(segRow[A] - segRow[B]);
  double total = cost + len * 0.1;
  i32 relayRow = -1, cA = -1, cB = -1;
  // no shared column: a bus-row relay, two vertical hops joined by a claimed
  // span of pin-free copper. A clean relay through a row between the strips is
  // the cheapest possible and ends the search.
  if (cost >= 50 && nBus) {
    i32 rLo = imin(segRow[A], segRow[B]), rHi = imax(segRow[A], segRow[B]);
    i32 sa = tree[ti];
    for (i32 bi2 = 0; bi2 < nBus; bi2++) {
      i32 r = busRows[bi2];
      if (r == segRow[A] || r == segRow[B]) continue;
      // a relay through r costs at least this much (no crossings): when that
      // cannot beat the best so far, its hops need not be looked up (the hop
      // cache is exact and filled lazily, so the result is the same)
      i32 rl = iabs(segRow[A] - r) + iabs(segRow[B] - r);
      if (!(3 + rl * 0.1 < total)) continue;
      i32 hA = hopCached(sa, bi2);
      if (hA < 0) continue;
      i32 hB = hopCached(b2, bi2);
      if (hB < 0) continue;
      i32 ca = hA & 0xffff, cb = hB & 0xffff;
      i32 lo2 = imin(ca, cb), hi2 = imax(ca, cb);
      int taken = 0;
      for (i32 q = clHead[r]; q >= 0; q = clNext[q]) if (clNet[q] != curNet && clC1[q] <= hi2 && lo2 <= clC2[q]) { taken = 1; break; }
      if (taken) continue;
      i32 cr = (hA >> 16) + (hB >> 16);
      double t = 3 + cr * 8 + rl * 0.1;
      if (t < total) {
        total = t;
        cross = cr;
        len = rl;
        relayRow = r;
        cA = ca;
        cB = cb;
        if (cr == 0 && r > rLo && r < rHi) break;
      }
    }
  }
  if (force || total < kTotal[b2]) {
    kTotal[b2] = total;
    kA[b2] = ti;
    kCross[b2] = cross;
    kLen[b2] = len;
    kCol[b2] = bestCol;
    kOff[b2] = relayRow < 0 && cost >= 50 ? 1 : 0;
    kRow[b2] = relayRow;
    kCA[b2] = cA;
    kCB[b2] = cB;
  }
}
static void rekey(i32 b2) {
  offer(0, b2, 1);
  for (i32 ti = 1; ti < treeN; ti++) offer(ti, b2, 0);
}

// the node a net pin sits on (pinYExpr): node into *node, row offset returned
static i32 pinY(i32 q, i32 *node) {
  i32 pi = npPi[q];
  if (npKind[q] == 0) {
    *node = pi;
    return spRow[sPinStart[geoShape[pi]] + npPinIdx[4 * q + rotOf[pi]]];
  }
  if (geoMode[pi] == 1) { *node = pi; return 0; }
  int isTop = (npEnd[q] == 0) == (gBr[pIdx[pi]] == 0);
  *node = isTop ? pi : vBotArr[pi];
  return 0;
}

static void grpSplit(i32 net, i32 k) {
  i32 s = npStart[net], e = npStart[net + 1];
  i32 mx = gGrp[s];
  for (i32 q = s + 1; q < e; q++) if (gGrp[q] > mx) mx = gGrp[q];
  gGrp[s + k] = mx + 1;
}

static void find(i32 v0, i32 *root, i32 *off) {
  i32 v = v0, o = 0;
  while (parent[v] != v) {
    o += poff[v];
    v = parent[v];
  }
  *root = v;
  *off = o;
}

// outI: 0 status (0 infeasible, 1 the reference board, 2 new board), 1 nNode,
// 2 H, 3 W, 4 wires, 5 wireLen, 6 relays, 7 cuts, 8 bCuts, 9 starved,
// 10 starvedHard, 11 geoBad, 12 overlapBad, 13 lockOver, 14 spanBad,
// 15 slants, 16 crossings, 17 ringBad
// outD: 0 eBase, 1 hardPen, 2 connEdge
static i32 decode(void) {
  if (exOn) { exSeg.n = 0; exCut.n = 0; exWire.n = 0; tr.n = 0; }
  for (i32 i = 0; i < nP; i++) { posP[gGp[i]] = i; posN[gGn[i]] = i; }
  // geometry per part
  i32 nNode = nP;
  for (i32 pi = 0; pi < nP; pi++) {
    vBotArr[pi] = -1;
    if (pKind[pi] == 0) {
      i32 rot = pLocked[pi] ? pLockRot[pi] : gRot[pIdx[pi]];
      rotOf[pi] = rot;
      i32 s = pShapeBase[pi] + rot;
      geoShape[pi] = s; geoW[pi] = sW[s]; geoH[pi] = sH[s]; geoMode[pi] = 0;
      outKey[pi] = rot;
    } else {
      i32 hmode = gHv[pIdx[pi]] == 1 && fCanH[pi];
      geoShape[pi] = -1;
      if (hmode) { geoMode[pi] = 1; geoW[pi] = fDc0[pi] + 1; geoH[pi] = 1; }
      else { geoMode[pi] = 2; geoW[pi] = 1; geoH[pi] = 0; }
      outKey[pi] = 10 + geoMode[pi];
    }
  }
  for (i32 k = 0; k < nFlex; k++) {
    i32 pi = flexList[k];
    if (geoMode[pi] == 2) vBotArr[pi] = nNode++;
  }
  i32 SRC = nNode++;
  outI[1] = nNode;

  // y: constraint edges
  i32 nE = 0;
#define ADDE(u, v, w) do { eU[nE] = (u); eV[nE] = (v); eW[nE] = (w); nE++; } while (0)
  for (i32 i = 0; i < nNode - 1; i++) ADDE(SRC, i, 0);
  for (i32 k = 0; k < nFlex; k++) {
    i32 pi = flexList[k];
    if (geoMode[pi] != 2) continue;
    i32 b = vBotArr[pi];
    ADDE(pi, b, fMinS[pi]);
    ADDE(b, pi, -fMaxS[pi]);
  }
  for (i32 i = 0; i < nP; i++) {
    if (pLocked[i]) continue;
    // The part's bottom node and its offset: a vertical flex ends at its bottom
    // pin node, anything else at its own node plus its height. The gap is
    // optimistic, the part's own clearance only: real pair clearances are
    // checked exactly at decoded coordinates and priced. Independent of the
    // part below, which the pruning below relies on.
    i32 bu = vBotArr[i] >= 0 ? vBotArr[i] : i;
    i32 w0 = (vBotArr[i] >= 0 ? 0 : geoH[i] - 1) + imax(1, pClr[i]) + gGap[i];
    i32 pi_ = posP[i], ni = posN[i];
    // nearest successors only: any other part below i is reached through one
    // of them with at least this edge's weight (the weight does not depend on
    // j), so the longest paths are the same with far fewer edges
    i32 seen = -1;
    for (i32 q = pi_ + 1; q < nP; q++) {
      i32 j = gGp[q];
      i32 nj = posN[j];
      if (nj > ni || pLocked[j]) continue;
      if (nj < seen) continue;
      seen = nj;
      ADDE(bu, j, w0);
    }
  }
  i32 nLock = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    if (!pLocked[pi]) continue;
    if (pKind[pi] == 0) { lockN[nLock] = pi; lockV[nLock++] = pLockY0[pi]; }
    else {
      lockN[nLock] = pi; lockV[nLock++] = pLockY0[pi];
      if (vBotArr[pi] >= 0) { lockN[nLock] = vBotArr[pi]; lockV[nLock++] = pLockY1[pi]; }
    }
  }
  for (i32 k = 0; k < nLock; k++) { ADDE(SRC, lockN[k], lockV[k]); ADDE(lockN[k], SRC, -lockV[k]); }
#undef ADDE
  if (trOn) {
    trp(TR_EDGES); trp(nE);
    for (i32 ei = 0; ei < nE; ei++) { trp(eU[ei]); trp(eV[ei]); trp(eW[ei]); }
  }

  // Group equalities via weighted union-find; a conflict splits the pin out of
  // its group persistently (written back into the genome). Relaxation runs in
  // first-sequence order (source first, a flex part's bottom right after its
  // top): every sequence-pair edge points down that sequence, so a feasible
  // graph settles in a few sweeps.
  for (i32 pi = 0; pi < nP; pi++) rankOf[pi] = 2 * posP[pi] + 1;
  for (i32 k = 0; k < nFlex; k++) { i32 pi = flexList[k]; if (vBotArr[pi] >= 0) rankOf[vBotArr[pi]] = 2 * posP[pi] + 2; }
  rankOf[SRC] = 0;
  fillD(dist, -1e18, nNode);
  i32 solved = 0;
  for (i32 attempt = 0; attempt < 400 && !solved; attempt++) {
    if (trOn) trp(TR_ATTEMPT);
    for (i32 i = 0; i < nNode; i++) { parent[i] = i; poff[i] = 0; lastNet[i] = -1; }
    // conflict: -1 none, -2 hard, else a net pin (net, k)
    i32 conflict = -1, cNet = -1, cK = -1;
    for (i32 n = 0; n < nNets; n++) {
      i32 s = npStart[n], cnt = npStart[n + 1] - s;
      for (i32 k = 0; k < cnt; k++) {
        i32 gl = gGrp[s + k];
        // anchor: the first pin of this net with the same label
        i32 a = -1;
        for (i32 q = 0; q < k; q++) if (gGrp[s + q] == gl) { a = q; break; }
        if (a < 0) continue;
        // an earlier pin that was split away no longer carries this label,
        // but the anchor is where the label FIRST appeared in this pass
        i32 u, v, ru, du, rv, dv;
        i32 ou = pinY(s + a, &u);
        i32 ov = pinY(s + k, &v);
        find(u, &ru, &du);
        find(v, &rv, &dv);
        if (ru == rv) {
          if (du + ou != dv + ov) {
            if (refuseSplit()) { outI[0] = 0; return 0; }
            grpSplit(n, k);
            if (trOn) { trp(TR_TIE_SPLIT); trp(n); trp(k); trp(u); trp(ou); trp(v); trp(ov); }
          } else if (trOn) { trp(TR_TIE_OK); trp(n); trp(u); trp(ou); trp(v); trp(ov); }
          continue;
        }
        parent[rv] = ru;
        poff[rv] = du + ou - dv - ov;
        if (trOn) { trp(TR_TIE_JOIN); trp(n); trp(u); trp(ou); trp(v); trp(ov); trp(poff[rv] + dv - du); }
        lastNet[rv] = -1;
        lastNet[ru] = n;
        lastK[ru] = k;
      }
    }
    for (i32 v = 0; v < nNode; v++) find(v, &rootArr[v], &offArr[v]);
    if (trOn) { trp(TR_ROOTS); for (i32 v = 0; v < nNode; v++) trp(rootArr[v]); }
    i32 nR = 0;
    for (i32 ei = 0; ei < nE; ei++) {
      i32 ru = rootArr[eU[ei]], rv = rootArr[eV[ei]];
      double w = eW[ei] + offArr[eU[ei]] - offArr[eV[ei]];
      if (ru == rv) {
        if (w > 0 && conflict == -1) {
          if (lastNet[ru] >= 0) {
            conflict = 0; cNet = lastNet[ru]; cK = lastK[ru];
            if (trOn) { trp(TR_CONFLICT); trp(eU[ei]); trp(eV[ei]); trp(eW[ei]); trp(offArr[eU[ei]]); trp(offArr[eV[ei]]); }
          }
          else conflict = -2;
        }
        continue;
      }
      rU[nR] = ru; rV[nR] = rv; rW[nR] = w; rRank[nR] = rankOf[eU[ei]]; rE[nR] = ei;
      nR++;
    }
    if (conflict != -1) {
      if (conflict == -2 || refuseSplit()) { outI[0] = 0; return 0; }
      grpSplit(cNet, cK);
      if (trOn) { trp(TR_CONFLICT_SPLIT); trp(cNet); trp(cK); }
      continue;
    }
    i32 nCnt = 2 * nP + 4;
    fillI(rankCnt, 0, nCnt);
    for (i32 ei = 0; ei < nR; ei++) rankCnt[rRank[ei] + 1]++;
    for (i32 b2 = 1; b2 < nCnt; b2++) rankCnt[b2] += rankCnt[b2 - 1];
    for (i32 ei = 0; ei < nR; ei++) ordBuf[rankCnt[rRank[ei]]++] = ei;
    fillD(dist, -1e18, nNode);
    dist[SRC] = 0;
    fillI(pred, -1, nNode);
    i32 changed = 0, lastEdge = -1, cycleAt = -1;
    for (i32 it = 0; it < nNode + 2; it++) {
      changed = 0;
      for (i32 k = 0; k < nR; k++) {
        i32 ei = ordBuf[k];
        i32 u = rU[ei], v = rV[ei];
        if (dist[u] + rW[ei] > dist[v] + 1e-9) {
          dist[v] = dist[u] + rW[ei];
          pred[v] = ei;
          changed = 1;
          lastEdge = ei;
          if (trOn && it < 2) {
            i32 oe = rE[ei];
            if (eU[oe] != SRC && eV[oe] != SRC) {
              trp(TR_RELAX); trp(oe);
              for (i32 n = 0; n < nNode - 1; n++) trp((dist[rootArr[n]] < -1e17 ? 0 : dist[rootArr[n]]) + offArr[n]);
            }
          }
        }
      }
      if (trOn && changed && it >= 2) {
        trp(TR_SWEEP); trp(it);
        for (i32 n = 0; n < nNode - 1; n++) trp((dist[rootArr[n]] < -1e17 ? 0 : dist[rootArr[n]]) + offArr[n]);
      }
      if (!changed) break;
      // a positive cycle closes the predecessor walk long before the round
      // bound would prove it: stop at the first closed walk
      if (it >= 2) {
        walkStamp++;
        i32 cur = rV[lastEdge];
        for (i32 s2 = 0; s2 <= nNode; s2++) {
          if (walkSeen[cur] == walkStamp) { cycleAt = cur; break; }
          walkSeen[cur] = walkStamp;
          i32 ei = pred[cur];
          if (ei < 0) break;
          cur = rU[ei];
        }
        if (cycleAt >= 0) break;
      }
    }
    if (!changed) {
      for (i32 v = 0; v < nNode; v++) dist[v] = dist[rootArr[v]] + offArr[v];
      solved = 1;
      break;
    }
    i32 cur = cycleAt >= 0 ? cycleAt : rV[lastEdge];
    for (i32 s = 0; s < nNode + 2; s++) {
      i32 ei = pred[cur];
      if (ei < 0) break;
      cur = rU[ei];
    }
    i32 fixed = 0;
    i32 start = cur;
    for (i32 s = 0; s < nNode + 2 && !fixed; s++) {
      if (lastNet[cur] >= 0) {
        if (refuseSplit()) { outI[0] = 0; return 0; }
        grpSplit(lastNet[cur], lastK[cur]);
        if (trOn) { trp(TR_CYCLE_SPLIT); trp(lastNet[cur]); trp(lastK[cur]); }
        fixed = 1;
        break;
      }
      i32 ei = pred[cur];
      if (ei < 0) break;
      cur = rU[ei];
      if (cur == start) break;
    }
    if (!fixed) { outI[0] = 0; return 0; }
  }
  if (!solved) { outI[0] = 0; return 0; }
  double *y = dist;
  if (trOn) { trp(TR_Y_DONE); for (i32 n = 0; n < nNode - 1; n++) trp(y[n]); }

  // x: sequence-pair left edges + locked pins; longest path. Two parts that
  // share rows always keep one free column between them: every pin segment
  // then has an attachment hole on at least one side, so a proposal cannot
  // starve a net by packing parts edge to edge (starved proposals were
  // rejected outright and cut the landscape into pieces the walk could not
  // cross). Edges come in first-sequence order, so the sweep settles fast.
  i32 XS = nP, nX = 0;
#define ADDX(u, v, w) do { xU[nX] = (u); xV[nX] = (v); xW[nX] = (w); nX++; } while (0)
  for (i32 i = 0; i < nP; i++) ADDX(XS, i, 0);
  for (i32 r = 0; r < nP; r++) {
    i32 i = gGp[r];
    if (pLocked[i]) continue;
    double ti = y[i], bi = vBotArr[i] >= 0 ? y[vBotArr[i]] : ti + geoH[i] - 1;
    i32 pi_ = posP[i], ni = posN[i];
    for (i32 q = pi_ + 1; q < nP; q++) {
      i32 j = gGp[q];
      if (ni > posN[j] || pLocked[j]) continue;
      double tj = y[j], bj = vBotArr[j] >= 0 ? y[vBotArr[j]] : tj + geoH[j] - 1;
      double margin = imax(1, pClr[i]) >= 2 ? 1.5 : 0.5;
      if (!(bi < tj - margin || bj < ti - margin)) {
        i32 fi = pKind[i] == 1, fj = pKind[j] == 1, hg;
        if (fi && fj) hg = 1 + imax(1, imax(pClr[i], pClr[j]));
        else if (!fi && !fj) hg = 2;
        else { i32 f = fi ? i : j; hg = geoMode[f] == 2 ? 1 + imax(1, pClr[f]) : 2; }
        ADDX(i, j, geoW[i] - 1 + hg + gXgap[i]);
      }
    }
  }
  for (i32 pi = 0; pi < nP; pi++) {
    if (!pLocked[pi]) continue;
    ADDX(XS, pi, pLockX[pi]);
    ADDX(pi, XS, -pLockX[pi]);
  }
#undef ADDX
  if (trOn) {
    trp(TR_X_START); trp(nX);
    for (i32 ei = 0; ei < nX; ei++) { trp(xU[ei]); trp(xV[ei]); trp(xW[ei]); }
  }
  fillD(xd, -1e18, nP + 1);
  xd[XS] = 0;
  i32 xOK = 1;
  for (i32 it = 0; it < nP + 3; it++) {
    i32 ch = 0;
    for (i32 ei = 0; ei < nX; ei++) {
      i32 u = xU[ei], v = xV[ei];
      if (xd[u] + xW[ei] > xd[v] + 1e-9) {
        xd[v] = xd[u] + xW[ei];
        ch = 1;
        if (trOn && u != XS) { trp(TR_X_RELAX); trp(ei); for (i32 i = 0; i <= nP; i++) trp(xd[i]); }
      }
    }
    if (!ch) { xOK = 1; break; }
    xOK = 0;
  }
  if (!xOK) { outI[0] = 0; return 0; }

  i32 *yI = outYI, *xI = outXI;
  for (i32 i = 0; i < nNode - 1; i++) yI[i] = jsRound(y[i]);
  yI[nNode - 1] = 0;
  for (i32 i = 0; i < nP; i++) xI[i] = jsRound(xd[i]);
  // A proposal that puts every part on the same hole in the same shape is the
  // reference board, and its measurement stands as is (about a third of all
  // proposals: the label and gap moves that do not bite)
  if (refHdr[0]) {
    i32 same = refHdr[1] == nNode;
    for (i32 i = 0; same && i < nNode - 1; i++) if (yI[i] != refYI[i]) same = 0;
    for (i32 i = 0; same && i < nP; i++) if (xI[i] != refXI[i] || outKey[i] != refKey[i]) same = 0;
    for (i32 i = 0; same && i < nFlex; i++) if (gBr[i] != refBr[i]) same = 0;
    if (same) { outI[0] = 1; return 1; }
  }
  if (trOn) trp(TR_X_DONE);

  // ── grid + exact measurement ──
  H = 0; W = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    i32 bot = geoMode[pi] == 2 ? yI[vBotArr[pi]] : yI[pi] + geoH[pi] - 1;
    H = imax(H, bot + 1);
    W = imax(W, xI[pi] + geoW[pi]);
  }
  // one blank line of margin on every free side: the finish pads its board the
  // same way, so edge segments really do have an attachment hole there and the
  // rim rows serve as bus rows
  GH = H + 2 * mRow; GW = W + 2 * mCol;
  ensureGrid((GH + 1) * GW, GH, GW);
  for (i32 i = 0; i < GH * GW; i++) { occ[i] = 0; owner[i] = -1; pinNetAt[i] = -1; }
  overlapBad = 0;
  // a pin without a net still breaks the strip it sits on (the router isolates
  // floating pins), so it claims a private pseudo-net: the cuts it forces get
  // counted and the copper beyond it no longer joins nets
  floatNet = nNets;
  nLockedBoxes = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    if (!pLocked[pi] || pKind[pi] != 0) continue;
    lbR1[nLockedBoxes] = yI[pi]; lbR2[nLockedBoxes] = yI[pi] + geoH[pi] - 1;
    lbC1[nLockedBoxes] = xI[pi]; lbC2[nLockedBoxes] = xI[pi] + geoW[pi] - 1;
    nLockedBoxes++;
  }
  i32 ringBad = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    if (pKind[pi] == 0) {
      i32 s = geoShape[pi];
      for (i32 r = 0; r < sH[s]; r++) for (i32 c = 0; c < sW[s]; c++) claim(yI[pi] + r, xI[pi] + c, 1, -1, pi);
      for (i32 q = sPinStart[s]; q < sPinStart[s] + sPinCnt[s]; q++) claim(yI[pi] + spRow[q], xI[pi] + spCol[q], 2, spNet[q] >= 0 ? spNet[q] : floatNet++, pi);
    } else {
      i32 brBit = gBr[pIdx[pi]];
      i32 nA = brBit == 0 ? fNa[pi] : fNb[pi], nB = brBit == 0 ? fNb[pi] : fNa[pi];
      if (geoMode[pi] == 1) {
        i32 dc0 = fDc0[pi];
        for (i32 c = 0; c <= dc0; c++) {
          if (c > 0 && c < dc0) claim(yI[pi], xI[pi] + c, 1, -1, pi);
          if (flexCellBad(yI[pi], xI[pi] + c, 0)) ringBad++;
        }
        claimBody(pi, yI[pi], xI[pi], yI[pi], xI[pi] + dc0);
        claim(yI[pi], xI[pi], 2, nA >= 0 ? nA : floatNet++, pi);
        claim(yI[pi], xI[pi] + dc0, 2, nB >= 0 ? nB : floatNet++, pi);
      } else {
        i32 t = yI[pi], b = yI[vBotArr[pi]];
        for (i32 r = t; r <= b; r++) {
          if (r > t && r < b) claim(r, xI[pi], 1, -1, pi);
          if (flexCellBad(r, xI[pi], 1)) ringBad++;
        }
        claimBody(pi, t, xI[pi], b, xI[pi]);
        claim(t, xI[pi], 2, nA >= 0 ? nA : floatNet++, pi);
        claim(b, xI[pi], 2, nB >= 0 ? nB : floatNet++, pi);
      }
    }
  }

  // runs, cuts, segments per row; nets in the order they first appear
  i32 cuts = 0, bCuts = 0, nNetSeen = 0;
  nSeg = 0; nBus = 0;
  for (i32 n = 0; n < floatNet; n++) netSegCnt[n] = 0;
#define FLUSH(endC, net) do { \
    i32 nn_ = (net); \
    if (netSegCnt[nn_] == 0) { netOrder[nNetSeen++] = nn_; netFirst[nn_] = nSeg; } else segNext[lastSegOf[nn_]] = nSeg; \
    segRow[nSeg] = r; segC1[nSeg] = segStart; segC2[nSeg] = (endC); segNetOf[nSeg] = nn_; segNext[nSeg] = -1; \
    lastSegOf[nn_] = nSeg; netSegCnt[nn_]++; nSeg++; \
    if (exOn) exSegAdd(r, segStart, (endC), nn_); \
  } while (0)
  i32 *lastSegOf = segLastBuf;
  for (i32 r = 0; r < GH; r++) {
    i32 nPins = 0;
    for (i32 c = 0; c < GW; c++) {
      i32 i = r * GW + c;
      if (occ[i] == 2 && pinNetAt[i] >= 0) { rowPinC[nPins] = c; rowPinN[nPins++] = pinNetAt[i]; }
    }
    // a pin-free row is a bus row: copper a net may claim over a span to travel
    // sideways between two vertical hops
    if (nPins == 0) {
      busRows[nBus++] = r;
      if (exOn) exSegAdd(r, 0, GW - 1, -1);
      continue;
    }
    i32 segStart = 0, cur = rowPinN[0], lastPinC = rowPinC[0];
    for (i32 k = 1; k < nPins; k++) {
      if (rowPinN[k] != cur) {
        cuts++;
        i32 gap = rowPinC[k] - lastPinC;
        if (gap >= 2) {
          FLUSH(lastPinC + 1 - 1, cur);
          segStart = lastPinC + 2;
          if (exOn) exCutAdd(r, lastPinC + 1, 0, rowPinC[k]);
        } else {
          bCuts++;
          FLUSH(lastPinC, cur);
          segStart = rowPinC[k];
          if (exOn) exCutAdd(r, lastPinC, 1, rowPinC[k]);
        }
        cur = rowPinN[k];
      }
      lastPinC = rowPinC[k];
    }
    FLUSH(GW - 1, cur);
  }
#undef FLUSH

  // Wires: per-net MST over segments, realizability-aware. Body cells per
  // column above each row, so the bodies a vertical wire would cross between
  // two rows come out of one subtraction. Both grids are built row by row, a
  // free-hole word at a time (column by column was a tenth of the decode).
  fillB(used, 0, GH * GW);
  for (i32 c = 0; c < GW; c++) bodyPre[c] = 0;
  for (i32 r = 0; r < GH; r++) {
    const i32 *p = bodyPre + r * GW;
    i32 *q = bodyPre + (r + 1) * GW;
    const int8_t *o = occ + r * GW;
    for (i32 c = 0; c < GW; c++) q[c] = p[c] + (o[c] == 1);
  }
  i32 wires = 0, wireLen = 0, slants = 0, crossings = 0, starved = 0, starvedHard = 0, relays = 0;
  WPR = (GW + 31) >> 5;
  for (i32 i = 0; i < GH * WPR; i++) usedM[i] = 0;
  for (i32 r = 0; r < GH; r++) {
    const int8_t *o = occ + r * GW;
    for (i32 w = 0; w < WPR; w++) {
      u32 m = 0;
      for (i32 c = w << 5, e = imin(GW, (w << 5) + 32); c < e; c++) m |= (u32)(o[c] == 0) << (c & 31);
      freeM[r * WPR + w] = m;
    }
  }
  fillI(clHead, -1, GH);
  clN = 0;
  for (i32 oi = 0; oi < nNetSeen; oi++) {
    i32 net = netOrder[oi];
    i32 k = netSegCnt[net];
    if (k < 2) continue;
    curNet = net;
    if (trOn) { trp(TR_NET); trp(net); trp(k); }
    i32 starved0 = starvedHard + starved;
    for (i32 s = netFirst[net], q = 0; s >= 0; s = segNext[s]) sIdx[q++] = s;
    // Prim keys: per outside segment, its cheapest link from the tree (the
    // earliest tree member on ties, so the pick matches a full scan in tree
    // order). A link only consumes holes on its two rows, so keys of segments
    // elsewhere stay exact and are not recomputed.
    for (i32 q = 0; q < k; q++) { linkCount[q] = 0; inTree[q] = 0; }
    treeN = 1;
    tree[0] = 0;
    inTree[0] = 1;
    if (k * nBus > hopCap) {
      hopCap = imax(k * nBus, hopCap * 2);
      hopCache = ALLOC(i32, hopCap);
    }
    fillI(hopCache, -2, k * nBus);
    for (i32 b2 = 1; b2 < k; b2++) rekey(b2);
    while (treeN < k) {
      i32 bb = -1;
      for (i32 b2 = 0; b2 < k; b2++) {
        if (inTree[b2]) continue;
        if (bb < 0 || kTotal[b2] < kTotal[bb] || (kTotal[b2] == kTotal[bb] && kA[b2] < kA[bb])) bb = b2;
      }
      i32 a = tree[kA[bb]];
      inTree[bb] = 1;
      tree[treeN++] = bb;
      wireLen += kLen[bb];
      crossings += kCross[bb];
      if (kOff[bb]) slants++;
      if (exOn) {
        i32 A = sIdx[a], B = sIdx[bb];
        if (kRow[bb] >= 0) {
          i32 r = kRow[bb];
          exWireAdd(segRow[A], kCA[bb], r, kCA[bb], net, 0, 0);
          exWireAdd(r, kCB[bb], segRow[B], kCB[bb], net, 0, 0);
          exSegAdd(r, imin(kCA[bb], kCB[bb]), imax(kCA[bb], kCB[bb]), net);
          if (trOn) trp(TR_RELAY);
        } else if (kCol[bb] >= 0) {
          exWireAdd(segRow[A], kCol[bb], segRow[B], kCol[bb], net, 0, kCross[bb]);
          if (trOn) {
            // the holes the explainer marks: which columns could take the link
            i32 lo = imax(segC1[A], segC1[B]), hi = imin(segC2[A], segC2[B]);
            i32 ra = segRow[A] * GW, rb = segRow[B] * GW;
            i32 preTop = (imin(segRow[A], segRow[B]) + 1) * GW, preBot = imax(segRow[A], segRow[B]) * GW;
            trp(TR_STRAIGHT); trp(hi - lo + 1);
            for (i32 c = lo; c <= hi; c++) {
              int ok = occ[ra + c] == 0 && occ[rb + c] == 0 && (c == kCol[bb] || (!used[ra + c] && !used[rb + c])) && bodyPre[preBot + c] - bodyPre[preTop + c] == 0;
              trp(c); trp(ok);
            }
          }
        } else {
          exWireAdd(segRow[A], jsRound((segC1[A] + segC2[A]) / 2.0), segRow[B], jsRound((segC1[B] + segC2[B]) / 2.0), net, 1, 0);
          if (trOn) trp(TR_SLANT);
        }
      }
      if (kRow[bb] >= 0) {
        i32 r = kRow[bb];
        markUsed(segRow[sIdx[a]], kCA[bb]);
        markUsed(r, kCA[bb]);
        markUsed(r, kCB[bb]);
        markUsed(segRow[sIdx[bb]], kCB[bb]);
        clC1[clN] = imin(kCA[bb], kCB[bb]); clC2[clN] = imax(kCA[bb], kCB[bb]); clNet[clN] = net;
        clNext[clN] = clHead[r]; clHead[r] = clN; clN++;
        wires += 2;
        relays++;
      } else {
        wires++;
        if (kCol[bb] >= 0) {
          markUsed(segRow[sIdx[a]], kCol[bb]);
          markUsed(segRow[sIdx[bb]], kCol[bb]);
        }
      }
      linkCount[a]++;
      linkCount[bb]++;
      // a consumed hole only ever raises a pair's cost, and only when the key
      // relied on that hole: just those keys are recomputed, the rest only
      // hear the new member's offer (claims never collide inside one net, so
      // relay keys depend on their four holes alone)
      i32 tn = treeN - 1;
      for (i32 b2 = 0; b2 < k; b2++) {
        if (inTree[b2]) continue;
        i32 rb = segRow[sIdx[b2]] * GW, ra = segRow[sIdx[tree[kA[b2]]]] * GW;
        i32 stale = 0;
        if (kRow[b2] >= 0) {
          i32 rr = kRow[b2] * GW;
          stale = used[ra + kCA[b2]] || used[rr + kCA[b2]] || used[rr + kCB[b2]] || used[rb + kCB[b2]];
        } else if (kCol[b2] >= 0) {
          stale = used[ra + kCol[b2]] || used[rb + kCol[b2]];
        }
        if (stale) rekey(b2);
        else offer(tn, b2, 0);
      }
    }
    // a linked segment without any free hole cannot take its wire at all
    // (hard); one whose only free hole the link consumes leaves the router no
    // slack (soft)
    for (i32 q = 0; q < k; q++) {
      if (linkCount[q] == 0) continue;
      i32 s = sIdx[q];
      i32 fr = 0, spare = 0;
      for (i32 c = segC1[s]; c <= segC2[s] && spare == 0; c++) {
        if (occ[segRow[s] * GW + c] != 0) continue;
        fr++;
        if (!used[segRow[s] * GW + c]) spare++;
      }
      if (fr == 0) starvedHard++;
      else if (spare == 0) starved++;
    }
    if (trOn && starvedHard + starved > starved0) { trp(TR_STARVED); trp(net); }
  }

  i32 spanBad = 0;
  for (i32 k = 0; k < nFlex; k++) {
    i32 pi = flexList[k];
    if (geoMode[pi] != 2) continue;
    i32 span = yI[vBotArr[pi]] - yI[pi];
    if (!(span >= 0 && span <= fMaxS[pi] && vdTab[fVdOff[pi] + span])) spanBad++;
  }

  // exact clearance checks at decoded coordinates (the pair-exact rules the
  // blanket gaps approximated), sorted by top row; a pair is skipped as soon as
  // B starts below A's reach. A rigid part's box takes in its reach, or a part
  // under a shaft is never even compared with it.
  i32 geoBad = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    rcPi[pi] = pi;
    if (pKind[pi] == 0) {
      i32 s = geoShape[pi];
      rcKind[pi] = 0;
      double *bd = rcBody + 4 * pi, *rc = rcReach + 4 * pi;
      bd[0] = yI[pi] + sBody[4 * s]; bd[1] = yI[pi] + sBody[4 * s + 1]; bd[2] = xI[pi] + sBody[4 * s + 2]; bd[3] = xI[pi] + sBody[4 * s + 3];
      rcHasReach[pi] = sHasReach[s];
      double rMinR = __builtin_inf(), rMaxR = -__builtin_inf(), rMinC = __builtin_inf(), rMaxC = -__builtin_inf();
      if (sHasReach[s]) {
        rc[0] = yI[pi] + sReach[4 * s]; rc[1] = yI[pi] + sReach[4 * s + 1]; rc[2] = xI[pi] + sReach[4 * s + 2]; rc[3] = xI[pi] + sReach[4 * s + 3];
        rMinR = rc[0]; rMaxR = rc[1]; rMinC = rc[2]; rMaxC = rc[3];
      }
      rcMinR[pi] = dfloor(dmin(yI[pi], rMinR)); rcMaxR[pi] = dceil(dmax(yI[pi] + geoH[pi] - 1, rMaxR));
      rcMinC[pi] = dfloor(dmin(xI[pi], rMinC)); rcMaxC[pi] = dceil(dmax(xI[pi] + geoW[pi] - 1, rMaxC));
    } else {
      rcKind[pi] = 1;
      rcHasReach[pi] = 0;
      i32 r2 = geoMode[pi] == 1 ? yI[pi] : yI[vBotArr[pi]];
      i32 c2 = geoMode[pi] == 1 ? xI[pi] + fDc0[pi] : xI[pi];
      double *p = rcP + 4 * pi;
      p[0] = yI[pi]; p[1] = xI[pi]; p[2] = r2; p[3] = c2;
      flexBody(pi, yI[pi], xI[pi], r2, c2, rcCap + 5 * pi);
      double *cp = rcCap + 5 * pi, *cb = rcCB + 4 * pi, *pb = rcPB + 4 * pi;
      cb[0] = dmin(cp[0], cp[2]); cb[1] = dmax(cp[0], cp[2]); cb[2] = dmin(cp[1], cp[3]); cb[3] = dmax(cp[1], cp[3]);
      pb[0] = dmin(p[0], p[2]); pb[1] = dmax(p[0], p[2]); pb[2] = dmin(p[1], p[3]); pb[3] = dmax(p[1], p[3]);
      rcMinR[pi] = yI[pi]; rcMaxR[pi] = r2; rcMinC[pi] = xI[pi]; rcMaxC[pi] = c2;
    }
  }
  // stable merge sort of part indices by minRow (Array.prototype.sort is stable)
  for (i32 i = 0; i < nP; i++) rcOrd[i] = i;
  for (i32 wdt = 1; wdt < nP; wdt *= 2) {
    for (i32 lo = 0; lo < nP; lo += 2 * wdt) {
      i32 mid = imin(lo + wdt, nP), hi = imin(lo + 2 * wdt, nP);
      i32 a = lo, b = mid, o = lo;
      while (a < mid && b < hi) rcTmp[o++] = rcMinR[rcOrd[b]] < rcMinR[rcOrd[a]] ? rcOrd[b++] : rcOrd[a++];
      while (a < mid) rcTmp[o++] = rcOrd[a++];
      while (b < hi) rcTmp[o++] = rcOrd[b++];
    }
    for (i32 i = 0; i < nP; i++) rcOrd[i] = rcTmp[i];
  }
  for (i32 a = 0; a < nP; a++) {
    i32 A = rcOrd[a];
    for (i32 b2 = a + 1; b2 < nP; b2++) {
      i32 B = rcOrd[b2];
      if (rcMinR[B] > rcMaxR[A] + clrPad) break;
      if (rcMinC[A] > rcMaxC[B] + clrPad || rcMinC[B] > rcMaxC[A] + clrPad) continue;
      i32 lines = imax(pLines[A], pLines[B]);
      // The exact tests below cost up to sixteen square roots. Two shapes whose
      // boxes lie the clash distance apart cannot clash, and the tests' own
      // 1e-6 margin keeps the skip exact.
      if (rcKind[A] == 1 && rcKind[B] == 1) {
        double *pa = rcP + 4 * A, *pb = rcP + 4 * B;
        if (boxesApart(rcCB + 4 * A, rcCB + 4 * B, rcCap[5 * A + 4] + rcCap[5 * B + 4] + clearanceAir(lines)) && boxesApart(rcPB + 4 * A, rcPB + 4 * B, 1e-6)) continue;
        if (segmentsIntersect(pa[0], pa[1], pa[2], pa[3], pb[0], pb[1], pb[2], pb[3])) geoBad++;
        else if (capsulesClash(rcCap + 5 * A, rcCap + 5 * B, lines)) geoBad++;
      } else if (rcKind[A] == 1 || rcKind[B] == 1) {
        i32 Fp = rcKind[A] == 1 ? A : B, R = rcKind[A] == 1 ? B : A;
        double *bd = rcBody + 4 * R, *rc = rcReach + 4 * R, r = rcCap[5 * Fp + 4];
        double eb[4] = { bd[0] - 0.5, bd[1] + 0.5, bd[2] - 0.5, bd[3] + 0.5 }, er[4] = { rc[0] - 0.5, rc[1] + 0.5, rc[2] - 0.5, rc[3] + 0.5 };
        if (boxesApart(rcCB + 4 * Fp, eb, r + clearanceAir(lines)) && (!rcHasReach[R] || boxesApart(rcCB + 4 * Fp, er, r))) continue;
        if (capsuleClashesRect(rcCap + 5 * Fp, rcBody + 4 * R, lines) || (rcHasReach[R] && capsuleClashesRect(rcCap + 5 * Fp, rcReach + 4 * R, 0))) geoBad++;
      } else if (
        bodyRectsClash(rcBody + 4 * A, rcBody + 4 * B, lines) ||
        (rcHasReach[A] && bodyRectsClash(rcReach + 4 * A, rcBody + 4 * B, 0)) || (rcHasReach[B] && bodyRectsClash(rcReach + 4 * B, rcBody + 4 * A, 0)) ||
        (rcHasReach[A] && rcHasReach[B] && bodyRectsClash(rcReach + 4 * A, rcReach + 4 * B, 0))
      ) {
        geoBad++;
      }
    }
  }

  // price (layout2/boardPrice.ts priceBreakdown, the one objective the finish
  // shares)
  i32 lockOver = (lockColsCap >= 0 ? imax(0, W - lockColsCap) : 0) + (lockRowsCap >= 0 ? imax(0, H - lockRowsCap) : 0);
  double aspectOver = lockColsCap >= 0 || lockRowsCap >= 0 ? 0 : W_TALL * imax(0, H - W) * W + imax(0, W - 2 * H) * H;
  i32 physW = lockColsCap >= 0 ? imax(W, lockColsCap) : W;
  i32 physH = lockRowsCap >= 0 ? imax(H, lockRowsCap) : H;
  double connEdge = 0;
  for (i32 pi = 0; pi < nP; pi++) {
    if (!pIsConn[pi] || pLocked[pi]) continue;
    i32 h = geoMode[pi] == 2 ? yI[vBotArr[pi]] - yI[pi] + 1 : geoH[pi];
    i32 w = geoW[pi], x = xI[pi], yy = yI[pi];
    i32 entry = pKind[pi] == 0 ? sEntry[geoShape[pi]] : -1;
    i32 sd = pSides[pi] >= 0 ? pSides[pi] : sidesDef;
    const i32 FAR = 50;
    i32 dsd[4];
    dsd[0] = sd & 1 ? x : FAR;
    dsd[1] = sd & 2 ? physW - (x + w) : FAR;
    dsd[2] = sd & 4 ? yy : FAR;
    dsd[3] = sd & 8 ? physH - (yy + h) : FAR;
    i32 d = imin(imin(dsd[0], dsd[1]), imin(dsd[2], dsd[3]));
    int along = ((dsd[0] == d || dsd[1] == d) && h >= w) || ((dsd[2] == d || dsd[3] == d) && w >= h);
    int facesOut = entry < 0 || dsd[entry] == d;
    connEdge += (d <= 0 ? 0 : d == 1 ? 0.5 * CONN_FULL : d == 2 ? 0.75 * CONN_FULL : CONN_FULL) + 0.2 * d + (along ? 0 : 0.75 * CONN_FULL) + (facesOut ? 0 : CONN_FULL);
  }
  double shaftIn = 0;
  for (i32 k = 0; k < nRigid; k++) {
    i32 pi = rigidList[k];
    i32 s = geoShape[pi];
    if (!sHasReach[s] || pLocked[pi]) continue;
    double r0 = yI[pi] + sReach[4 * s] - 0.5, r1 = yI[pi] + sReach[4 * s + 1] + 0.5;
    double c0 = xI[pi] + sReach[4 * s + 2] - 0.5, c1 = xI[pi] + sReach[4 * s + 3] + 0.5;
    double inside = dmax(0, dmin(r1, physH - 0.5) - dmax(r0, -0.5)) * dmax(0, dmin(c1, physW - 0.5) - dmax(c0, -0.5));
    shaftIn += 30 * (inside / ((r1 - r0) * (c1 - c0)));
  }
  double sibling = 0;
  for (i32 gi = 0; gi < nSib; gi++) {
    i32 r0 = 0x7fffffff, r1 = -0x7fffffff, c0 = 0x7fffffff, c1 = -0x7fffffff, n = sgStart[gi + 1] - sgStart[gi];
    for (i32 q = sgStart[gi]; q < sgStart[gi + 1]; q++) {
      i32 pi = sgPi[q];
      r0 = imin(r0, yI[pi]); r1 = imax(r1, yI[pi]);
      c0 = imin(c0, xI[pi]); c1 = imax(c1, xI[pi]);
    }
    sibling += W_SIBLING * imax(0, r1 - r0 + (c1 - c0) - (n - 1));
  }
  double price =
    W_AREA * (physH * physW + aspectOver) + W_WIRE * wires + W_WLEN * wireLen +
    W_CUT * cuts + wBCut * bCuts + W_LOCKOVER * lockOver + connEdge + shaftIn + sibling;
  double eBase = price + overlapBad * 500 + geoBad * 450 + ringBad * 120 + spanBad * 60 + starved * 20 + starvedHard * 450;
  double hardPen = overlapBad * 500 + geoBad * 450 + starvedHard * 450;

  outI[0] = 2; outI[2] = H; outI[3] = W; outI[4] = wires; outI[5] = wireLen; outI[6] = relays; outI[7] = cuts; outI[8] = bCuts;
  outI[9] = starved; outI[10] = starvedHard; outI[11] = geoBad; outI[12] = overlapBad; outI[13] = lockOver; outI[14] = spanBad;
  outI[15] = slants; outI[16] = crossings; outI[17] = ringBad;
  outD[0] = eBase; outD[1] = hardPen; outD[2] = connEdge;
  return 2;
}

EXPORT(v5_decode) i32 v5_decode(void) { return decode(); }

// where the last decode's export and trace are: segments, cuts, wires (count,
// address), bus rows, the grid size, the trace (length, address)
EXPORT(v5_exportHdr) i32 *v5_exportHdr(void) {
  exHdr[0] = exSeg.n / 4; exHdr[1] = JSPTR(exSeg.a);
  exHdr[2] = exCut.n / 4; exHdr[3] = JSPTR(exCut.a);
  exHdr[4] = exWire.n / 7; exHdr[5] = JSPTR(exWire.a);
  exHdr[6] = nBus; exHdr[7] = JSPTR(busRows);
  exHdr[8] = GH; exHdr[9] = GW;
  exHdr[10] = tr.n; exHdr[11] = JSPTR(tr.a);
  return exHdr;
}

// ── the anneal loop: runs until the walk finds a new best, hands it to the
// TypeScript side (autoLayout5.ts solveSeed: the exact finish), and resumes.
// The start temperature is fixed: the landscape is plateaus between penalty
// cliffs (400-450 per violation), above ~150 the walk is random, and a
// calibrated start (2000-8000) wasted the first third of every run. Under a
// time budget the schedule follows the elapsed share of the budget or of the
// moves, whichever is further along, reading the clock every 32 moves. ──

#ifdef __wasm__
__attribute__((import_module("env"), import_name("now"))) double js_now(void);
__attribute__((import_module("env"), import_name("pow"))) double js_pow(double, double);
__attribute__((import_module("env"), import_name("exp"))) double js_exp(double);
__attribute__((import_module("env"), import_name("report"))) void js_report(double);
#else
#include <math.h>
#include <time.h>
static double js_now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
#define js_pow pow
#define js_exp exp
// the host's report and move-log callbacks, with its context
static void *nativeCtx;
static void (*nativeReport)(void *, double);
static void (*nativeMovelog)(void *, i32, i32);
EXPORT(native_setCallbacks) void native_setCallbacks(void *ctx, void (*report)(void *, double), void (*movelog)(void *, i32, i32)) {
  nativeCtx = ctx; nativeReport = report; nativeMovelog = movelog;
}
static void js_report(double f) { nativeReport(nativeCtx, f); }
#endif

#define W_MESS 400.0

static u32 rngState;
static double rngMain(void) {
  rngState = rngState + 0x6d2b79f5u;
  u32 a = rngState;
  u32 t = (a ^ (a >> 15)) * (1u | a);
  t = (t + (t ^ (t >> 7)) * (61u | t)) ^ t;
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}
static i32 rint_(i32 n) { return (i32)__builtin_floor(rngMain() * n); }

static void copyI(i32 *d, const i32 *s, i32 n) { for (i32 i = 0; i < n; i++) d[i] = s[i]; }
static void curToProp(void) {
  copyI(gGp, cGp, nP); copyI(gGn, cGn, nP); copyI(gRot, cRot, nRigid); copyI(gHv, cHv, nFlex); copyI(gBr, cBr, nFlex);
  copyI(gGap, cGap, nP); copyI(gXgap, cXgap, nP); copyI(gGrp, cGrp, nNP);
}
static void propToCur(void) {
  copyI(cGp, gGp, nP); copyI(cGn, gGn, nP); copyI(cRot, gRot, nRigid); copyI(cHv, gHv, nFlex); copyI(cBr, gBr, nFlex);
  copyI(cGap, gGap, nP); copyI(cXgap, gXgap, nP); copyI(cGrp, gGrp, nNP);
}

// arr.splice(arr.indexOf(a), 1)
static void removeVal(i32 *arr, i32 n, i32 a) {
  i32 i = 0;
  while (arr[i] != a) i++;
  for (; i < n - 1; i++) arr[i] = arr[i + 1];
}
// arr.splice(at, 0, a) on an array of n-1 live entries
static void insertAt(i32 *arr, i32 n, i32 at, i32 a) {
  for (i32 i = n - 1; i > at; i--) arr[i] = arr[i - 1];
  arr[at] = a;
}
static i32 indexOf(const i32 *arr, i32 n, i32 a) {
  for (i32 i = 0; i < n; i++) if (arr[i] == a) return i;
  return -1;
}
static void swapNear(i32 *arr) {
  i32 i = rint_(nP - 1);
  i32 j = imin(nP - 1, i + 1 + rint_(3));
  i32 t = arr[i]; arr[i] = arr[j]; arr[j] = t;
}

static i32 lean;
// move log on, and the current board's part sizes (what it compares)
static i32 mlOn;
static i32 *curGeoW, *curGeoH;
// The move mix. r below mix[0] throws a connector, below mix[1] pulls, and
// the next mix[12] of it pulls and ties. What is left of mix[2] (the share
// after throw and pull) is rescaled and split at the cumulative bounds
// mix[3..11] (swapP, swapN, swapBoth, rot, hv, br, grpMerge, gap, xgap;
// grpSplit takes what is left).
// Of all proposals: throw 6 %, pull 11 %, pull and tie 30 %, swapP and swapN
// 3.3 % each, swapBoth 4.15 %, rot 7.3 %, hv 9.15 %, br 7.3 %, grpMerge 11 %,
// gap and xgap 2.3 % each, grpSplit 2.9 %.
// History: swapBoth and grpSplit were halved on 2026-09-26 (the fewest new
// bests per proposal; delivered board 3 % cheaper). Pull and tie came on
// 2026-09-27 and took its share from swapP and swapN, which were 41 % of all
// proposals but mostly wasted (refused by a strip tie, or the same board):
// at 30 % the mean seed was 6 % cheaper and the delivered board 4-6 %, on two
// samples of 120 projects, in the same time.
// Without pull and tie (mix[12] 0) the table is the 2026-09-26 one, which the
// stacked solve's leaves keep: their width-locked, port-heavy boards failed
// their finish far more often with it (setPullTie). A second table can take
// over from a share of the walk on (harness experiments; off by default).
static const double MIX_PULL_TIE[13] = { 0.06, 0.17, 0.83, 0.06226426415094339, 0.12452852830188678, 0.20283041509433958, 0.34094398113207547,
  0.5135855471698112, 0.6516975471698112, 0.8588686792452829, 0.902028679245283, 0.9451886792452828, 0.3 };
static const double MIX_NO_PULL_TIE[13] = { 0.06, 0.17, 0.83, 0.220482, 0.440964, 0.490964, 0.579157, 0.689398, 0.77759, 0.90988, 0.93744, 0.965, 0 };
static double mixEarly[13] = { 0.06, 0.17, 0.83, 0.06226426415094339, 0.12452852830188678, 0.20283041509433958, 0.34094398113207547,
  0.5135855471698112, 0.6516975471698112, 0.8588686792452829, 0.902028679245283, 0.9451886792452828, 0.3 };
static double mixLate[13] = { 0.06, 0.17, 0.83, 0.06226426415094339, 0.12452852830188678, 0.20283041509433958, 0.34094398113207547,
  0.5135855471698112, 0.6516975471698112, 0.8588686792452829, 0.902028679245283, 0.9451886792452828, 0.3 };
static double mixLateFrom = 2, mixProgress = 0;
EXPORT(v5_setMix) void v5_setMix(i32 late, i32 k, double v) { (late ? mixLate : mixEarly)[k] = v; }
EXPORT(v5_setMixLateFrom) void v5_setMixLateFrom(double f) { mixLateFrom = f; }
// the default mix with (1) or without (0) pull and tie
EXPORT(v5_setPullTie) void v5_setPullTie(i32 on) {
  for (i32 k = 0; k < 13; k++) mixEarly[k] = mixLate[k] = (on ? MIX_PULL_TIE : MIX_NO_PULL_TIE)[k];
}
// the proposal: the current genome with one move applied (0: no move)
static i32 mutate(int cold) {
  double r = rngMain();
  const double *M = mixProgress >= mixLateFrom ? mixLate : mixEarly;
  mvKind = -1;
  // low-temperature mix: only the move kinds that stay on the plateau (pull,
  // sequence swaps, branch flip, label merge, gap toggles)
  if (cold) {
    static const double bands[8][3] = { { 0.06, 0.17, 8 }, { 0.17, 0.336, 22 }, { 0.336, 0.502, 22 }, { 0.502, 0.585, 12 }, { 0.7344, 0.8008, 6 }, { 0.8008, 0.9004, 14 }, { 0.9004, 0.92115, 8 }, { 0.92115, 0.9419, 8 } };
    double x = rngMain() * 100;
    i32 b = 0;
    for (i32 k = 0; k < 8; k++) { if (x < bands[k][2]) { b = k; break; } x -= bands[k][2]; }
    r = bands[b][0] + rngMain() * (bands[b][1] - bands[b][0]);
  }
  curToProp();
  // Side-switch teleport: throw a connector to the opposite end of both
  // sequences (the other board edge). Connectors stacked on one edge set the
  // board height; the area price already prefers a split, but ordinary swaps
  // cannot carry a connector across the board.
  if (r < M[0] && nP >= 3) {
    mvKind = 0;
    if (!nConns) return 0;
    i32 a = conns[rint_(nConns)];
    int back = rngMain() < 0.5;
    i32 *arrs[2] = { gGp, gGn };
    for (i32 q = 0; q < 2; q++) {
      removeVal(arrs[q], nP, a);
      insertAt(arrs[q], nP, back ? nP - 1 : 0, a);
    }
    return 1;
  }
  // Pull: a part next to a mate on one of its nets, on either side in both
  // orders. Pull and tie also puts the part's pins on that net onto the
  // mate's strip (the label of the mate's first pin there); its other strips
  // stay. A plain pull cannot make that tie, and with ties senior to the
  // orders a tied part often cannot move at all without it.
  if (r < M[1] + M[12] && nP >= 3) {
    int tie = r >= M[1];
    mvKind = tie ? 12 : 1;
    if (!nPull) return 0;
    i32 c = rint_(nPull);
    const i32 *ps = pullPi + pullStart[c];
    i32 len = pullStart[c + 1] - pullStart[c];
    i32 a = ps[rint_(len)];
    i32 bi = rint_(len), b = ps[bi];
    if (a == b) b = ps[(bi + 1) % len];
    if (a == b) return 0;
    i32 side = rngMain() < 0.5 ? 0 : 1;
    i32 *arrs[2] = { gGp, gGn };
    for (i32 q = 0; q < 2; q++) {
      removeVal(arrs[q], nP, a);
      insertAt(arrs[q], nP, indexOf(arrs[q], nP - 1, b) + side, a);
    }
    if (tie) {
      i32 n = pullNet[c], s = npStart[n], e = npStart[n + 1], L = -1;
      for (i32 q = s; q < e; q++) if (npPi[q] == b) { L = gGrp[q]; break; }
      for (i32 q = s; q < e; q++) if (npPi[q] == a) gGrp[q] = L;
    }
    return 1;
  }
  r = (r - M[1] - M[12]) / (M[2] - M[12]);
  if (nP < 2) {
    mvKind = 5;
    if (nRigid > 0 && !pLocked[rigidList[0]]) {
      gRot[0] = (gRot[0] + (halfTurn[0] ? 2 : 1 + rint_(3))) % 4;
      return 1;
    }
    return 0;
  }
  if (r < M[3]) { mvKind = 2; swapNear(gGp); }
  else if (r < M[4]) { mvKind = 3; swapNear(gGn); }
  else if (r < M[5]) {
    mvKind = 4;
    swapNear(gGp);
    swapNear(gGn);
  } else if (r < M[6] && nRigid > 0) {
    mvKind = 5;
    if (lean && !nRotK) return 0;
    i32 k = lean ? rotK[rint_(nRotK)] : rint_(nRigid);
    gRot[k] = (gRot[k] + (halfTurn[k] ? 2 : 1 + rint_(3))) % 4;
  } else if (r < M[7] && nFlex > 0) {
    mvKind = 6;
    i32 k = rint_(nFlex);
    if (canHV[k]) gHv[k] = 1 - gHv[k];
    else return 0;
  } else if (r < M[8] && nFlex > 0) {
    mvKind = 7;
    i32 k = rint_(nFlex);
    gBr[k] = 1 - gBr[k];
  } else if (r < M[9]) {
    mvKind = 8;
    i32 n = rint_(nNets);
    if (n >= nNets) return 0;
    i32 s = npStart[n], cnt = npStart[n + 1] - s;
    if (cnt < 2) return 0;
    i32 a = rint_(cnt), b = rint_(cnt);
    if (a == b) b = (b + 1) % cnt;
    if (lean && gGrp[s + a] == gGrp[s + b]) return 0;
    gGrp[s + a] = gGrp[s + b];
  } else if (r < M[10]) {
    mvKind = 9; // open or close blank rows below a part (bus-row supply)
    i32 i = rint_(nP);
    gGap[i] = gGap[i] > 0 ? 0 : 1 + rint_(2);
  } else if (r < M[11]) {
    mvKind = 10; // open or close blank columns right of a part (attachment holes)
    i32 i = rint_(nP);
    gXgap[i] = gXgap[i] > 0 ? 0 : 1 + rint_(2);
  } else {
    mvKind = 11;
    i32 n = rint_(nNets);
    if (n >= nNets) return 0;
    i32 s = npStart[n], cnt = npStart[n + 1] - s;
    if (cnt < 2) return 0;
    i32 a = rint_(cnt);
    if (lean) {
      i32 v = gGrp[s + a], m = 0;
      for (i32 q = 0; q < cnt; q++) if (gGrp[s + q] == v) m++;
      if (m == 1) return 0;
    }
    i32 mx = gGrp[s];
    for (i32 q = 1; q < cnt; q++) if (gGrp[s + q] > mx) mx = gGrp[s + q];
    gGrp[s + a] = 1 + mx;
  }
  return 1;
}

static void initGenome(void) {
  for (i32 i = 0; i < nP; i++) gGp[i] = i;
  for (i32 i = nP - 1; i > 0; i--) { i32 j = (i32)__builtin_floor(rngMain() * (i + 1)); i32 t = gGp[i]; gGp[i] = gGp[j]; gGp[j] = t; }
  for (i32 i = 0; i < nP; i++) gGn[i] = i;
  for (i32 i = nP - 1; i > 0; i--) { i32 j = (i32)__builtin_floor(rngMain() * (i + 1)); i32 t = gGn[i]; gGn[i] = gGn[j]; gGn[j] = t; }
  fillI(gRot, 0, nRigid); fillI(gHv, 0, nFlex); fillI(gBr, 0, nFlex);
  fillI(gGrp, 0, nNP); fillI(gGap, 0, nP); fillI(gXgap, 0, nP);
}

// the proposal becomes the current state; a new board also becomes the
// reference the next proposals are compared with
static void acceptProp(i32 st) {
  propToCur();
  if (st != 2) return;
  for (i32 i = 0; i < 18; i++) curI[i] = outI[i];
  for (i32 i = 0; i < 3; i++) curD[i] = outD[i];
  i32 nNode = outI[1];
  copyI(refYI, outYI, nNode); copyI(refXI, outXI, nP); copyI(refKey, outKey, nP); copyI(refBr, gBr, nFlex);
  if (mlOn) { copyI(curGeoW, geoW, nP); copyI(curGeoH, geoH, nP); }
  refHdr[1] = nNode;
}

// ── the explainer's lab: a starting genome, or one move on the genome the
// TypeScript side wrote in as the current one, both into the proposal
// buffers, drawing from a random state the lab keeps ──
EXPORT(v5_rngSet) void v5_rngSet(u32 s) { rngState = s; }
EXPORT(v5_rngGet) u32 v5_rngGet(void) { return rngState; }
EXPORT(v5_rand) double v5_rand(void) { return rngMain(); }
EXPORT(v5_labInit) void v5_labInit(void) { initGenome(); }
EXPORT(v5_labMutate) i32 v5_labMutate(void) { return mutate(0); }

// harness move log (autoLayout5.ts MoveLogRec, one row of ML_W per proposal),
// handed over in batches
#ifdef __wasm__
__attribute__((import_module("env"), import_name("movelog"))) void js_movelog(double *rows, i32 n);
#else
static void js_movelog(double *rows, i32 n) { nativeMovelog(nativeCtx, JSPTR(rows), n); }
#endif
#define ML_W 20
#define ML_CAP 4096
static double *mlBuf;
static i32 mlN;
static void mlFlush(void) {
  if (mlN) js_movelog(mlBuf, mlN);
  mlN = 0;
}
static double priceFinOf(const i32 *I, const double *D);
// out: 0 no move, 1 infeasible, 2 rejected, 3 accepted; b/bD the proposal's
// board (NULL for out < 2)
static void mlRecord(i32 it, i32 out, i32 best, const i32 *b, const double *bD, i32 st, double dE) {
  double *r = mlBuf + ML_W * mlN;
  for (i32 k = 0; k < ML_W; k++) r[k] = 0;
  r[0] = it; r[1] = mvKind; r[2] = out; r[3] = best;
  r[7] = priceFinOf(curI, curD);
  if (b) {
    const i32 *a = curI;
    const double *aD = curD;
    i32 same = a[2] == b[2] && a[3] == b[3] && aD[0] == bD[0] && aD[1] == bD[1];
    if (same && st == 2) {
      for (i32 i = 0; i < nP; i++) {
        if (outYI[i] != refYI[i] || outXI[i] != refXI[i] || geoW[i] != curGeoW[i] || geoH[i] != curGeoH[i]) { same = 0; break; }
      }
    }
    r[4] = same;
    r[5] = dE;
    r[6] = priceFinOf(b, bD) - priceFinOf(a, aD);
    r[8] = b[2] * b[3] - a[2] * a[3];
    r[9] = b[4] - a[4]; r[10] = b[5] - a[5]; r[11] = b[7] - a[7]; r[12] = b[8] - a[8];
    r[13] = b[15] + b[16] - a[15] - a[16];
    r[14] = bD[1] - aD[1];
    r[15] = b[9] - a[9];
    r[16] = bD[0] - aD[0] - (W_AREA * r[8] + W_WIRE * r[9] + W_WLEN * r[10] + W_CUT * r[11] + wBCut * r[12] + r[14] + 20 * r[15]);
    r[17] = b[11] - a[11]; r[18] = b[12] - a[12]; r[19] = b[10] - a[10];
  }
  if (++mlN == ML_CAP) mlFlush();
}
EXPORT(v5_setMoveLog) void v5_setMoveLog(i32 on) {
  mlOn = on;
  mlN = 0;
  if (on && !mlBuf) { mlBuf = ALLOC(double, ML_W * ML_CAP); curGeoW = ALLOC(i32, nP); curGeoH = ALLOC(i32, nP); }
}

static i32 L_it, L_movesN, L_timed, L_reportEvery, L_started;
static double L_budgetMs, L_t0, L_tEnd, L_coldT, L_cool, L_rampStart, L_rampEnd, L_hardStart, L_T, L_f, L_fTime, L_tStart, L_bestE, L_protect;
// the cooling curve's shape: T = t0 * (tEnd / t0)^(f^shape); above 1 the walk
// stays hot longer and cools late (harness experiments; 1 is the plain curve)
static double L_shape = 1;
EXPORT(v5_setShape) void v5_setShape(double p) { L_shape = p; }

static double priceOf(const i32 *I, const double *D, double w, double hardScale) { return D[0] + w * (I[15] + I[16]) + (hardScale - 1) * D[1]; }
static double priceFinOf(const i32 *I, const double *D) { return D[0] + W_MESS * (I[15] + I[16]); }

EXPORT(v5_annealStart) void v5_annealStart(u32 seedState, u32 strictSeed, double protect, i32 movesN, i32 timed, double budgetMs,
    double t0, double tEnd, double coldT, double cool, double rampStart, double rampEnd, double hardStart, i32 reportEvery, i32 leanMoves) {
  rngState = seedState; strictState = strictSeed; strictTies = 0; L_protect = protect;
  L_movesN = movesN; L_timed = timed; L_budgetMs = budgetMs; L_t0 = t0; L_tEnd = tEnd; L_coldT = coldT; L_cool = cool;
  L_rampStart = rampStart; L_rampEnd = rampEnd; L_hardStart = hardStart; L_reportEvery = reportEvery; lean = leanMoves;
  L_started = 0;
}

// loopI: 0 it, 1 event (1 start, 2 new best); loopD: 0 the schedule's share
// at the event, 1 its price. Returns 1 at an event, 0 when the walk is done,
// -1 when no starting genome decodes.
EXPORT(v5_annealStep) i32 v5_annealStep(void) {
  if (!L_started) {
    L_started = 1;
    initGenome();
    refHdr[0] = 0;
    i32 st = decode();
    i32 tries = 0;
    while (!st && tries++ < 50) {
      initGenome();
      st = decode();
    }
    if (!st) return -1;
    acceptProp(2);
    strictTies = L_protect;
    L_T = L_t0; L_it = 0; L_fTime = 0; L_f = 0;
    L_tStart = js_now();
    L_bestE = priceFinOf(curI, curD);
    loopI[0] = 0; loopI[1] = 1; loopD[0] = 0; loopD[1] = L_bestE;
    return 1;
  }
  for (; L_it < L_movesN; L_it++) {
    double itV = L_it;
    if (L_timed) {
      if ((L_it & 31) == 0) L_fTime = (js_now() - L_tStart) / L_budgetMs;
      L_f = dmax((double)L_it / L_movesN, L_fTime);
      if (L_f >= 1 && L_it >= 40000) break;
      if (L_f >= 1) L_f = 1;
      L_T = L_t0 * js_pow(L_tEnd / L_t0, L_shape == 1 ? L_f : js_pow(L_f, L_shape));
      itV = L_f * L_movesN;
    } else if (L_shape == 1) L_T *= L_cool;
    else L_T = L_t0 * js_pow(L_tEnd / L_t0, js_pow((double)L_it / L_movesN, L_shape));
    mixProgress = (double)L_it / L_movesN;
    if (L_it % L_reportEvery == 0) js_report(L_timed ? L_f : (double)L_it / L_movesN);
    i32 ok = 0;
    for (i32 tries = 0; tries < 50; tries++) {
      ok = mutate(L_T < L_coldT);
      if (ok || !lean) break;
    }
    if (!ok) { if (mlOn) mlRecord(L_it, 0, 0, 0, 0, 0, 0); continue; }
    refHdr[0] = 1;
    i32 st = decode();
    if (!st) { if (mlOn) mlRecord(L_it, 1, 0, 0, 0, 0, 0); continue; }
    double w = dmin(W_MESS, L_rampStart * js_pow(W_MESS / L_rampStart, itV / L_rampEnd));
    double hardScale = L_hardStart >= 1 ? 1 : dmin(1, L_hardStart * js_pow(1 / L_hardStart, itV / L_rampEnd));
    const i32 *nI = st == 2 ? outI : curI;
    const double *nD = st == 2 ? outD : curD;
    double dE = priceOf(nI, nD, w, hardScale) - priceOf(curI, curD, w, hardScale);
    i32 accepted = dE <= 0 || rngMain() < js_exp(-dE / L_T);
    if (!accepted) { if (mlOn) mlRecord(L_it, 2, 0, nI, nD, st, dE); continue; }
    double eFin = priceFinOf(nI, nD);
    i32 isBest = eFin < L_bestE;
    if (mlOn) mlRecord(L_it, 3, isBest, nI, nD, st, dE);
    acceptProp(st);
    if (isBest) {
      L_bestE = eFin;
      loopI[0] = L_it; loopI[1] = 2; loopD[0] = L_timed ? L_f : (double)L_it / L_movesN; loopD[1] = eFin;
      L_it++;
      mlFlush();
      return 1;
    }
  }
  loopI[0] = L_it;
  mlFlush();
  return 0;
}
