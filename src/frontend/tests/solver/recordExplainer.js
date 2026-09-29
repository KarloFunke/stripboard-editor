// Records the explainer's fixed walkthroughs from the real engine (the decoder
// and the wire router in WebAssembly, the finish in TypeScript) into
// app/how-auto-layout-works/figures/walk/recorded.json:
//   genomeRun   what the section 8 run (seed 7, 25,000 steps) settles on
//   decodeWalk  every frame of the decode of walkGenome.json (sections 6 and 7)
//   finishWalk  both finishes of genomeRun, drilled cuts and no stacked wires (section 9)
// Run it after any change to the decoder, its scoring or the finish:
//   npx tsc -p tests/solver/tsconfig.json && node tests/solver/recordExplainer.js
const fs = require("fs");
const path = require("path");
require("./helpers.js");
const OUT = path.join(__dirname, "out");
const { computeAutoLayout5 } = require(path.join(OUT, "components/stripboard/autoLayout5.js"));
const { DEFAULT_COMPONENTS } = require(path.join(OUT, "data/defaultComponents.js"));

const walk = path.join(__dirname, "../../app/how-auto-layout-works/figures/walk");
const proj = JSON.parse(fs.readFileSync(path.join(walk, "example555.json"), "utf8"));
const genome = JSON.parse(fs.readFileSync(path.join(walk, "walkGenome.json"), "utf8"));
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../../components/stripboard/v5wasm/v5decode.wasm")));
const comps = proj.components.map((c) => ({ ...c, boardPos: null, rotation: 0 }));
const board = { ...proj.board, cuts: [], wires: [], lockedRows: false, lockedCols: false };
const labOf = (extra) => {
  let api;
  computeAutoLayout5(board, comps, DEFAULT_COMPONENTS, proj.nets, proj.netAssignments, undefined, { lab: (a) => { api = a; }, wasm, ...extra });
  return api;
};
const LAB = labOf({});
const LAB_FINISH = labOf({ drilledCutsOnly: true, noWireStacking: true });

let genomeRun;
LAB.run(7, 25000, 25000, (s) => { if (s.done) genomeRun = s.bestG; });
const decodeWalk = LAB.decode(LAB.cloneG(genome), true).frames;
const finishWalk = LAB_FINISH.finishBoth(LAB_FINISH.cloneG(genomeRun));
const file = path.join(walk, "recorded.json");
fs.writeFileSync(file, JSON.stringify({ genomeRun, decodeWalk, finishWalk }) + "\n");
console.log(`${file}: ${decodeWalk.length} decode frames, ${finishWalk.router.frames.length} + ${finishWalk.repair?.frames.length ?? 0} finish frames, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
