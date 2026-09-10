const fs=require("fs"), path=require("path"); const { spawn }=require("child_process");
const D="/home/karlo/stripboard-editor/auto-layouter-data/human-2026-08-22"; const S=__dirname; // results land next to the scripts
const idx=JSON.parse(fs.readFileSync(path.join(D,"index.json"),"utf8"));
const jobs=idx.filter(e=>e.unresolvedDefs===0&&!(e.shortedDefs>0)&&e.parts>=20).sort((a,b)=>b.parts-a.parts).map(e=>path.join(D,"projects",e.id+".json"));
jobs.push(path.join(D,"extra/mf-hw_v1.json"));
const results=[]; let running=0, i=0; const W=Number(process.argv[2]??14); const tag=process.argv[3]??"results"; const extra=process.argv.slice(4);
const next=()=>{ while(running<W&&i<jobs.length){ const f=jobs[i++]; running++; let out=""; const ch=spawn("node",[path.join(S,"bisect.js"),f,"--json",...extra]); ch.stdout.on("data",d=>out+=d); ch.stderr.on("data",d=>out+=d);
  ch.on("close",()=>{ running--; try{ const r=JSON.parse(out.trim().split("\n").pop()); r.file=f; results.push(r); console.log(`${r.id}: ${r.parts}p cut ${r.cut} best ${r.best.lockDim}=${r.best.size} -> ${r.best.rows}x${r.best.cols} q${r.best.quality} inc${r.best.incomplete} geo${r.best.geo} w${r.best.wires} mess${r.best.mess} rate ${r.best.rate.toFixed(0)} halves ${(r.best.halfMs/1000).toFixed(0)}s`);}catch{ console.log("ERR", f, out.slice(0,300)); } if(i>=jobs.length&&running===0) fs.writeFileSync(path.join(S,"bisect-"+tag+".json"),JSON.stringify(results)); else next(); }); } };
next();
