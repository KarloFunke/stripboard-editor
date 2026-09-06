// total part footprint: rigid bounds at rotation 0 plus a one-hole ring, flex = span + ring
const path=require("path"); const FRONT="/home/karlo/stripboard-editor/src/frontend";
const bl=require(path.join(FRONT,"tests/solver/out/components/stripboard/boardLayout.js"));
const fg=require(path.join(FRONT,"tests/solver/out/components/stripboard/flexGeometry.js"));
const { resolveComponentDef } = require(path.join(FRONT,"tests/solver/out/utils/resolveComponentDef.js"));
module.exports.footprint=(d, defs)=>{ let F=0, pins=0; for (const c of d.components) { if (c.boardExcluded) continue; const def=resolveComponentDef(c, defs); if(!def) continue; pins+=def.pins.length;
  if (def.flexible) { const lim=fg.spanLimits(def); F+=(lim.min+1)*3; } else { const b=bl.getComponentBounds(def,{row:0,col:0},0); F+=(b.maxRow-b.minRow+2)*(b.maxCol-b.minCol+2); } } return {F,pins}; };
