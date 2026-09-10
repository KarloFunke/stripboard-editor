// Bipartition prototype (harness only, not wired into the app): FM min-cut halves, common width from a v2 pass,
// two locked-width v5 solves, stacked with a seam row, finalized as one board.
//   node bisect.js <project.json> [--seeds K] [--width W] [--json]
const fs=require("fs"), path=require("path");
const FRONT="/home/karlo/stripboard-editor/src/frontend";
const OUT=path.join(process.env.OUT ?? path.join(FRONT,"tests/solver/out"), "components/stripboard");
const { DEFAULT_COMPONENTS, checkGeometry, verify } = require(path.join(FRONT,"tests/solver/helpers.js"));
const { metrics } = require(path.join(FRONT,"tests/solver/metricsLib.js"));
const { computeAutoLayout5 } = require(path.join(OUT,"autoLayout5.js"));
const { computeAutoLayout2, rateResult } = require(path.join(OUT,"autoLayout2.js"));
const { Chooser } = require(path.join(OUT,"layout2/chooser.js"));
const { insertWireChannels } = require(path.join(OUT,"layout2/channelPass.js"));
const { repairSlantWires } = require(path.join(OUT,"layout2/slantRepairPass.js"));
const { trimResult } = require(path.join(OUT,"layout2/trimResult.js"));
const { resolveComponentDef } = require(path.join(FRONT,"tests/solver/out/utils/resolveComponentDef.js"));
const args=process.argv.slice(2); const argVal=(n)=>{const i=args.indexOf("--"+n); return i>=0?args[i+1]:undefined;};
const file=args[0]; const seedsK=Number(argVal("seeds")??4); const widthOpt=argVal("width")?Number(argVal("width")):undefined;
const d=JSON.parse(fs.readFileSync(file,"utf8")); const defs=[...DEFAULT_COMPONENTS,...(d.componentDefs??[])];
const nets=d.nets??[], asg=d.netAssignments??[];
const blank=d.components.map(c=>({...c,boardPos:null,flexibleEndPos:undefined,rotation:0,locked:undefined}));
const placeable=blank.filter(c=>!c.boardExcluded);
const T=[]; const tick=(label)=>T.push([label,Date.now()]);
tick("start");
// ── partition (FM, pin-balanced, min cut nets) ──
let rng=7; const rand=()=>{rng=(rng*1103515245+12345)&0x7fffffff; return rng/0x7fffffff;};
const ids=placeable.map(c=>c.id); const pi=new Map(ids.map((p,i)=>[p,i])); const n=ids.length;
const pinsOf=new Int32Array(n); const netMap=new Map();
for (const a of asg) { const i=pi.get(a.componentId); if(i===undefined) continue; pinsOf[i]++; if(!netMap.has(a.netId)) netMap.set(a.netId,new Set()); netMap.get(a.netId).add(i); }
const netList=[...netMap.values()].filter(s=>s.size>=2).map(s=>[...s]); const totalPins=pinsOf.reduce((a,b)=>a+b,0); const minSide=Math.ceil(totalPins/3);
const partNets=ids.map(()=>[]); netList.forEach((ns,k)=>ns.forEach(i=>partNets[i].push(k)));
const cutCount=(side)=>netList.reduce((c,ns)=>c+(ns.some(i=>side[i]===0)&&ns.some(i=>side[i]===1)?1:0),0);
let best=null;
for (let restart=0; restart<60; restart++) {
  const side=new Int8Array(n); let pins=[0,0];
  const order=[...Array(n).keys()].sort(()=>rand()-0.5); for (const i of order) { const s=pins[0]<=pins[1]?0:1; side[i]=s; pins[s]+=pinsOf[i]; }
  for (let pass=0; pass<50; pass++) {
    let bestGain=0, bi=-1;
    for (let i=0;i<n;i++) { const from=side[i]; if (pins[from]-pinsOf[i]<minSide) continue;
      let gain=0; for (const k of partNets[i]) { const ns=netList[k]; const same=ns.filter(j=>j!==i&&side[j]===from).length, other=ns.length-1-same; if (same===0&&other>0) gain++; else if (other===0&&same>0) gain--; }
      if (gain>bestGain) { bestGain=gain; bi=i; } }
    if (bi<0) break; pins[side[bi]]-=pinsOf[bi]; side[bi]=1-side[bi]; pins[side[bi]]+=pinsOf[bi];
  }
  const c=cutCount(side); if (!best||c<best.cut) best={cut:c, side:Array.from(side)};
}
tick("partition");
// ── size estimate from a quick v2 pass ──
let W=widthOpt, Hest;
const est=argVal("est")??"v2"; const kPack=Number(argVal("k")??1.38), aspect=Number(argVal("aspect")??0.8);
if (est==="crude") { const {footprint}=require(path.join(__dirname,"footprint.js")); const A=kPack*footprint(d,defs).F; W=W??Math.max(4,Math.round(Math.sqrt(A/aspect))); Hest=Math.max(4,Math.round(Math.sqrt(A*aspect))); }
else { const v2=computeAutoLayout2({...d.board,cuts:[],wires:[],lockedRows:false,lockedCols:false}, blank, defs, nets, asg); W=W??(v2.boardSize?.cols ?? d.board.cols); Hest=v2.boardSize?.rows ?? d.board.rows; }
tick("v2size");
const { compactPlacements } = require(path.join(OUT,"layout2/compaction.js"));
const netOfPin=new Map(asg.map(a=>[a.componentId+":"+a.pinId, a.netId]));
// ── one composition: halves solved under a common locked dimension, stacked (cols) or paired (rows) ──
function compose(lockDim, size) {
  const halves=[0,1].map(s=>{
    const mine=new Set(ids.filter((id,i)=>best.side[i]===s));
    const comps=blank.map(c=>mine.has(c.id)?c:{...c,boardExcluded:true});
    const hAsg=asg.filter(a=>mine.has(a.componentId));
    const board=lockDim==="cols"?{...d.board,rows:8,cols:size,cuts:[],wires:[],lockedRows:false,lockedCols:true}:{...d.board,rows:size,cols:8,cuts:[],wires:[],lockedRows:true,lockedCols:false};
    const t0=Date.now(); const res=computeAutoLayout5(board, comps, defs, nets, hAsg, undefined, {seeds:seedsK});
    return {res,ms:Date.now()-t0};
  });
  const s0=halves[0].res.boardSize, s1=halves[1].res.boardSize;
  let rows, cols, shift;
  if (lockDim==="cols") { rows=s0.rows+1+s1.rows; cols=Math.max(size,s0.cols,s1.cols); shift=(q)=>({row:q.row+s0.rows+1,col:q.col}); }
  else { cols=s0.cols+1+s1.cols; rows=Math.max(size,s0.rows,s1.rows); shift=(q)=>({row:q.row,col:q.col+s0.cols+1}); }
  const byId=new Map();
  for (const p of halves[0].res.placements) byId.set(p.componentId,p);
  for (const p of halves[1].res.placements) byId.set(p.componentId,{...p,boardPos:shift(p.boardPos),...(p.flexibleEndPos?{flexibleEndPos:shift(p.flexibleEndPos)}:{})});
  const comps=blank.map(c=>{const p=byId.get(c.id); return p?{...c,boardPos:p.boardPos,rotation:p.rotation??0,flexibleEndPos:p.flexibleEndPos}:c;});
  const pad=(q)=>({row:q.row+1,col:q.col+1});
  const padded=comps.map(c=>c.boardPos?{...c,boardPos:pad(c.boardPos),...(c.flexibleEndPos?{flexibleEndPos:pad(c.flexibleEndPos)}:{})}:c);
  const routeBoard={...d.board,rows:rows+2,cols:cols+2,cuts:[],wires:[],lockedRows:false,lockedCols:false};
  const moved=new Set(comps.filter(c=>c.boardPos).map(c=>c.id));
  const chooser=new Chooser(routeBoard, defs, nets, asg, false, {}, false, true);
  const c0=chooser.route(padded, rows+2, cols+2, moved);
  chooser.freezePool();
  if (c0.bad===0) { const full=compactPlacements(c0.virtual, defs, netOfPin, c0.rows, c0.cols); if (full.removals>0) chooser.route(full.comps, full.rows, full.cols, c0.movedIds); }
  if (chooser.chosen.bad===0) insertWireChannels(chooser, defs, {}, false, true);
  if (chooser.chosen.bad===0) repairSlantWires(chooser, routeBoard, defs, asg, new Set());
  const ch=chooser.chosen;
  const result={placements: ch.virtual.filter(c=>moved.has(c.id)&&c.boardPos).map(c=>{const def=resolveComponentDef(c,defs); return def.flexible?{componentId:c.id,boardPos:c.boardPos,flexibleEndPos:c.flexibleEndPos}:{componentId:c.id,boardPos:c.boardPos,rotation:c.rotation};}),
    cuts:ch.plan.cuts, wires:ch.plan.wires, issues:[], quality:ch.plan.unresolvedConflicts*100+ch.plan.starvedNetIds.length, starvedNetIds:ch.plan.starvedNetIds, boardSize:{rows:ch.rows,cols:ch.cols}, unplaceIds:[]};
  const final={...result, ...trimResult(result, routeBoard, ch.virtual, defs, false)};
  const fById=new Map(final.placements.map(p=>[p.componentId,p]));
  const fComps=blank.map(c=>{const p=fById.get(c.id); return p?{...c,boardPos:p.boardPos,rotation:p.rotation??0,flexibleEndPos:p.flexibleEndPos}:c;});
  const fb={...d.board,...final.boardSize,cuts:final.cuts,wires:final.wires.map((w,i)=>({id:"w"+i,...w}))};
  const m=metrics(fb,fComps,defs,nets,asg); const v=verify(fb,fComps,nets,asg,defs); const geo=checkGeometry(fb,fComps,defs).length;
  const rate=rateResult(final, {...d.board,cuts:[],wires:[],lockedRows:false,lockedCols:false}, blank, defs, false);
  const quality=ch.plan.unresolvedConflicts*100+ch.plan.starvedNetIds.length;
  return {lockDim,size, halves:halves.map(h=>`${h.res.boardSize.rows}x${h.res.boardSize.cols} w${h.res.wires.length} q${h.res.quality} ${(h.ms/1000).toFixed(1)}s`), halfMs:halves.reduce((n,h)=>n+h.ms,0),
    rows:fb.rows, cols:fb.cols, area:fb.rows*fb.cols, quality, incomplete:v.incomplete.length??v.incomplete, conflicts:v.conflicts, geo, wires:m.wires, offAxis:m.offAxisWires, crossings:m.crossings, cuts:m.cuts, mess:ch.mess, rate,
    score:(quality+v.conflicts*100+(v.incomplete.length??v.incomplete)*10+geo)*1e9+(m.offAxisWires+m.crossings)*1e4+rate};
}
const cands=Number(argVal("cands")??1); const scales=cands>=3?[0.8,1,1.25]:cands===2?[0.85,1.15]:[1];
const variants=[]; for (const f of scales) { variants.push(compose("cols", Math.max(4,Math.round(W*f)))); variants.push(compose("rows", Math.max(4,Math.round(Hest*f)))); }
tick("compositions");
variants.sort((a,b)=>a.score-b.score); const bestV=variants[0];
const phases=T.slice(1).map(([l,t],i)=>`${l} ${((t-T[i][1])/1000).toFixed(1)}s`).join(", ");
const out={id:path.basename(file,".json"), parts:n, cut:best.cut, W, Hest, best:bestV, variants, ms:Date.now()-T[0][1], phases};
if (args.includes("--json")) console.log(JSON.stringify(out));
else { console.log(`${out.id}: ${n}p cut ${best.cut} W ${W} H ${Hest} total ${(out.ms/1000).toFixed(1)}s (${phases})`); for (const v of variants) console.log(`   ${v.lockDim}=${v.size} halves [${v.halves.join(" | ")}] -> ${v.rows}x${v.cols}=${v.area} q${v.quality} inc${v.incomplete} geo${v.geo} w${v.wires} mess${v.mess} cuts${v.cuts} rate ${v.rate.toFixed(0)}`); }
