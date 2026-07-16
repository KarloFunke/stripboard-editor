// Compare human-made layouts against the auto-solver on the same netlists.
//
// Projects are read LIVE from a local sqlite DB (never committed — *.sqlite3
// is gitignored) via the sqlite3 CLI; usernames and project names are passed
// as arguments so no private data ever appears in the repo.
//
//   node tests/solver/compare.js --db <path-to-db.sqlite3> --id <project-id>
//   node tests/solver/compare.js --db <path-to-db.sqlite3> --user <name> [--project <substr>]
//
// For each project it scores the stored human layout, then strips all
// placements/cuts/wires, runs the auto-solver (two seeds, like the editor),
// and prints both metric sets side by side.
const { spawnSync } = require("child_process");
const { metrics } = require("./metricsLib.js");
const {
  computeAutoLayout, computeAutoLayout2, computeStripSegments, computeConnectivity, checkNetCompleteness,
  flexGeometry, boardLayout, DEFAULT_COMPONENTS,
} = require("./helpers.js");

const RETRY_SEED = 0xbeef; // must match StripboardEditor's second wave

// ── CLI ────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argVal("db");
if (!dbPath) {
  console.error("usage: node compare.js --db <path> (--id N | --user NAME [--project SUBSTR])");
  process.exit(1);
}

function sql(query) {
  const r = spawnSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

function selectProjects() {
  const id = argVal("id");
  if (id) return sql(`SELECT p.id, p.name, p.data FROM projects_project p WHERE p.id = ${Number(id)};`);
  const user = argVal("user");
  if (!user) {
    console.error("pass --id or --user");
    process.exit(1);
  }
  const sub = argVal("project");
  const nameFilter = sub ? ` AND p.name LIKE '%${sub.replace(/'/g, "''")}%'` : "";
  return sql(
    `SELECT p.id, p.name, p.data FROM projects_project p JOIN auth_user u ON u.id = p.owner_id ` +
    `WHERE u.username = '${user.replace(/'/g, "''")}'${nameFilter} ORDER BY p.name;`
  );
}

// ── Run ────────────────────────────────────────────────

const projects = selectProjects();
if (projects.length === 0) {
  console.error("no projects matched");
  process.exit(1);
}

for (const proj of projects) {
  const data = JSON.parse(proj.data);
  const defs = [...DEFAULT_COMPONENTS, ...(data.componentDefs ?? [])];
  const nets = data.nets ?? [];
  const asg = data.netAssignments ?? [];
  const humanBoard = data.board;
  const humanComps = data.components;

  console.log(`\n━━ #${proj.id} "${proj.name}" — board ${humanBoard.rows}x${humanBoard.cols}, ${humanComps.length} parts, ${nets.length} nets ━━`);
  const human = metrics(humanBoard, humanComps, defs, nets, asg);

  // Only compare against FINISHED human layouts: half-done works in progress
  // (unplaced parts, conflicts, open nets) are not a fair yardstick.
  if (human.unplaced > 0 || human.conflicts > 0 || human.incomplete > 0) {
    if (!args.includes("--all")) {
      console.log(`human layout unfinished (unplaced=${human.unplaced}, conflicts=${human.conflicts}, incomplete=${human.incomplete}) — skipping (use --all to compare anyway)`);
      continue;
    }
    console.log(`note: human layout unfinished (unplaced=${human.unplaced}, conflicts=${human.conflicts}, incomplete=${human.incomplete})`);
  }

  // Solver gets the same netlist with a blank board. --engine v1 runs the
  // classic optimizer (two seeds, like it shipped); default is v2, which
  // chooses its own board size.
  const engine = argVal("engine") ?? "v2";
  const blankComps = humanComps.map((c) => ({ ...c, boardPos: null, flexibleEndPos: undefined, rotation: 0, locked: undefined }));
  const blankBoard = { ...humanBoard, cuts: [], wires: [] };
  const t0 = Date.now();
  let res;
  if (engine === "v1") {
    res = computeAutoLayout(blankBoard, blankComps, defs, nets, asg);
    if (res.quality > 0) {
      const retry = computeAutoLayout(blankBoard, blankComps, defs, nets, asg, undefined, { seed: RETRY_SEED });
      if (retry.quality < res.quality) res = retry;
    }
  } else {
    res = computeAutoLayout2(blankBoard, blankComps, defs, nets, asg);
  }
  const elapsed = Date.now() - t0;

  const byId = new Map(res.placements.map((p) => [p.componentId, p]));
  const solvedComps = blankComps.map((c) => {
    const p = byId.get(c.id);
    if (!p) return c;
    return {
      ...c,
      boardPos: p.boardPos,
      ...(p.rotation !== undefined ? { rotation: p.rotation } : {}),
      ...(p.flexibleEndPos !== undefined ? { flexibleEndPos: p.flexibleEndPos } : {}),
    };
  });
  const solvedBoard = {
    ...blankBoard,
    ...(res.boardSize ?? {}),
    cuts: res.cuts,
    wires: res.wires.map((w, i) => ({ id: `w${i}`, ...w })),
  };
  const solver = metrics(solvedBoard, solvedComps, defs, nets, asg);
  if (res.boardSize) console.log(`solver board: ${res.boardSize.rows}x${res.boardSize.cols} (human: ${humanBoard.rows}x${humanBoard.cols})`);

  const rows = [
    ["placed parts", "placed"], ["unplaced", "unplaced"], ["conflicts", "conflicts"],
    ["incomplete nets", "incomplete"], ["cuts", "cuts"], ["wires", "wires"],
    ["wire length", "wireLen"], ["off-axis wires", "offAxisWires"], ["wires over parts", "crossings"],
    ["strip-complete nets", "stripCompleteNets"], ["strip-complete %", "stripCompletePct"],
    ["cohesion (avg dist)", "cohesion"], ["bbox area", "bboxArea"],
  ];
  console.log(`solver time: ${(elapsed / 1000).toFixed(1)}s (quality ${res.quality})`);
  console.log("metric".padEnd(22) + "human".padStart(10) + "solver".padStart(10));
  for (const [label, key] of rows) {
    console.log(label.padEnd(22) + String(human[key]).padStart(10) + String(solver[key]).padStart(10));
  }
}
