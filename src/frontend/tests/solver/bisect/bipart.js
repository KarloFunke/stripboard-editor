// Feasibility: balanced min-cut of parts per big corpus project; usage: node bipart.js <extra project.json>
// Balanced min-cut bipartition of parts (hyperedges = nets), FM-style with restarts.
const fs=require("fs"), path=require("path");
const D="/home/karlo/stripboard-editor/auto-layouter-data/human-2026-08-22";
const final=JSON.parse(fs.readFileSync(path.join(D,"results/v5-final.json"),"utf8")).results;
const idx=JSON.parse(fs.readFileSync(path.join(D,"index.json"),"utf8"));
const files=idx.filter(e=>e.unresolvedDefs===0&&!(e.shortedDefs>0)&&e.parts>=20).map(e=>[e.id,path.join(D,"projects",e.id+".json")]);
files.push([108, process.argv[2]]);
let rng=1; const rand=()=>{rng=(rng*1103515245+12345)&0x7fffffff; return rng/0x7fffffff;};
const median=(xs)=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]};
const rows=[];
for (const [id,file] of files) {
  const d=JSON.parse(fs.readFileSync(file,"utf8"));
  const parts=d.components.filter(c=>!c.boardExcluded).map(c=>c.id); const pi=new Map(parts.map((p,i)=>[p,i])); const n=parts.length;
  const pinsOf=new Int32Array(n); const nets=new Map();
  for (const a of d.netAssignments) { const i=pi.get(a.componentId); if(i===undefined) continue; pinsOf[i]++; if(!nets.has(a.netId)) nets.set(a.netId,new Set()); nets.get(a.netId).add(i); }
  const netList=[...nets.values()].filter(s=>s.size>=2).map(s=>[...s]); const totalPins=pinsOf.reduce((a,b)=>a+b,0); const minSide=Math.ceil(totalPins/3);
  const partNets=parts.map(()=>[]); netList.forEach((ns,k)=>ns.forEach(i=>partNets[i].push(k)));
  const cutCount=(side)=>netList.reduce((c,ns)=>c+(ns.some(i=>side[i]===0)&&ns.some(i=>side[i]===1)?1:0),0);
  let best=null;
  for (let restart=0; restart<60; restart++) {
    const side=new Int8Array(n); let pins=[0,0];
    const order=[...Array(n).keys()].sort(()=>rand()-0.5); for (const i of order) { const s=pins[0]<=pins[1]?0:1; side[i]=s; pins[s]+=pinsOf[i]; }
    // FM passes: move the part with best gain that keeps balance; stop when no improving move
    for (let pass=0; pass<50; pass++) {
      let bestGain=0, bi=-1;
      for (let i=0;i<n;i++) { const from=side[i], to=1-from; if (pins[from]-pinsOf[i]<minSide) continue;
        let gain=0; for (const k of partNets[i]) { const ns=netList[k]; const same=ns.filter(j=>j!==i&&side[j]===from).length, other=ns.length-1-same; if (same===0&&other>0) gain++; else if (other===0&&same>0) gain--; }
        if (gain>bestGain) { bestGain=gain; bi=i; } }
      if (bi<0) break; pins[side[bi]]-=pinsOf[bi]; side[bi]=1-side[bi]; pins[side[bi]]+=pinsOf[bi];
    }
    const c=cutCount(side); if (!best||c<best.cut) best={cut:c, pins:[...pins], side:Array.from(side)};
  }
  const r=final.find(x=>x.id===id); const wires=r?r.best.wires:NaN; const board=r?`${r.best.rows}x${r.best.cols}`:"?";
  const bigCut=netList.filter(ns=>ns.some(i=>best.side[i]===0)&&ns.some(i=>best.side[i]===1)).map(ns=>ns.length).sort((a,b)=>b-a);
  rows.push({id,n,pins:totalPins,nets:netList.length,cut:best.cut,split:best.pins,wires,board,bigCut});
  console.log(`id ${String(id).padStart(3)} parts ${String(n).padStart(2)} pins ${String(totalPins).padStart(3)} nets ${String(netList.length).padStart(2)} | min cut nets ${String(best.cut).padStart(2)} (${(100*best.cut/netList.length).toFixed(0)}%) pins split ${best.pins.join("/")} | current board ${board} wires ${wires} -> interconnects ~${2*best.cut} of ${wires} | cut net sizes ${bigCut.slice(0,8).join(",")}`);
}
console.log(`\n${rows.length} projects: median cut nets ${median(rows.map(r=>r.cut))}, median cut fraction ${(100*median(rows.map(r=>r.cut/r.nets))).toFixed(0)}%, median 2*cut / current wires ${(100*median(rows.filter(r=>r.wires).map(r=>2*r.cut/r.wires))).toFixed(0)}%`);
