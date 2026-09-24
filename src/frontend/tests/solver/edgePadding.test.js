// A blank line at the rim must not cut a rim connector off its strip: a
// column insert may pin the connector to the edge (its row is unchanged),
// a row insert never does (its row is its strip).
const path = require("path");
const { DEFS, DIP8_DEF, CONN1_DEF, rigid, assert, finish } = require("./helpers.js");
const { insertLine, padAroundEdgeConnectors } = require(path.join(__dirname, "out/components/stripboard/layout2/edgePadding.js"));

const conn = rigid(CONN1_DEF.id, "J1", { boardPos: { row: 0, col: 0 } });
const dip = rigid(DIP8_DEF.id, "U1", { boardPos: { row: 0, col: 2 } });
const comps = [conn, dip];
const at = (cs, c) => cs.find((x) => x.id === c.id).boardPos;

{
  const out = insertLine(comps, DEFS, true, 0);
  assert(at(out, conn).col === 0 && at(out, dip).col === 3, "a left column pins the rim connector and shifts the rest");
  assert(at(out, conn).row === at(out, dip).row, "the connector still shares its strip after a column insert");
}
{
  const out = insertLine(comps, DEFS, false, 0);
  assert(at(out, conn).row === 1 && at(out, dip).row === 1, "a top row shifts the rim connector with the rest");
}
{
  const bottom = [rigid(CONN1_DEF.id, "J2", { boardPos: { row: 3, col: 0 } }), dip];
  const out = insertLine(bottom, DEFS, false, 4);
  assert(at(out, bottom[0]).row === 3 && at(out, dip).row === 0, "a bottom row moves nothing that lies above it");
}
{
  const p = padAroundEdgeConnectors(comps, DEFS, 4, 6, { top: 1, bottom: 1, left: 1, right: 2 });
  assert(p.rows === 6 && p.cols === 9, "padding grows the board by the lines asked for");
  assert(at(p.comps, conn).col === 0 && at(p.comps, dip).col === 3, "padding keeps the left rim connector on the rim");
  assert(at(p.comps, conn).row === 1 && at(p.comps, dip).row === 1, "padding keeps the connector on the strip it shared");
}

finish("edgePadding");
