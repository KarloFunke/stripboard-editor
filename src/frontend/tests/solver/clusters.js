// Stage-0 prototype CLI for the v2 layouter: cluster a project's netlist
// into the functional blocks a human would recognize and print them.
// See clusterLib.js for the algorithm.
//
// Reads projects live from a local sqlite DB (gitignored); no project data
// belongs in the repo. Usage:
//   node tests/solver/clusters.js --db <path-to-db.sqlite3> --id <project-id> [--cap N]
const { spawnSync } = require("child_process");
const { buildComponentGraph, agglomerate } = require("./clusterLib.js");

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argVal("db");
const projectId = argVal("id");
if (!dbPath || !projectId) {
  console.error("usage: node clusters.js --db <path> --id <project-id> [--cap N]");
  process.exit(1);
}

const r = spawnSync("sqlite3", ["-json", dbPath, `SELECT id, name, data FROM projects_project WHERE id = ${Number(projectId)};`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0 || !r.stdout.trim()) {
  console.error(r.stderr || "project not found");
  process.exit(1);
}
const proj = JSON.parse(r.stdout)[0];
const data = JSON.parse(proj.data);

const { compById, nodeIds, netComps, adj } = buildComponentGraph(data);
const n = nodeIds.length;
const { membership } = agglomerate(adj, n, Number(argVal("cap") ?? 12));
const netName = new Map((data.nets ?? []).map((net) => [net.id, net.name]));

console.log(`\n━━ #${proj.id} "${proj.name}" — ${n} components, ${netComps.size} nets ━━`);

const fanouts = [...netComps.entries()]
  .map(([id, m]) => ({ name: netName.get(id) ?? id, k: m.size }))
  .sort((a, b) => b.k - a.k);
console.log(`top-fanout nets (structurally power-like): ${fanouts.slice(0, 4).map((f) => `${f.name}(${f.k})`).join(", ")}`);

const clusters = new Map();
nodeIds.forEach((id, i) => {
  const c = membership[i];
  if (!clusters.has(c)) clusters.set(c, []);
  clusters.get(c).push(compById.get(id));
});

const label = (c) => (c.value ? `${c.label}=${c.value}` : c.label);
let ci = 0;
for (const [, members] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
  ci++;
  console.log(`\ncluster ${ci} (${members.length} parts):`);
  console.log(`  ${members.map(label).join(", ")}`);
}

const memberOf = new Map(nodeIds.map((id, i) => [id, membership[i]]));
let internal = 0;
const boundary = [];
for (const [netId, members] of netComps) {
  if (members.size < 2) continue;
  const span = new Set([...members].map((id) => memberOf.get(id)));
  if (span.size === 1) internal++;
  else boundary.push(`${netName.get(netId) ?? netId}(${span.size})`);
}
console.log(`\nnets internal to one cluster: ${internal}/${internal + boundary.length}`);
console.log(`boundary nets: ${boundary.join(", ") || "none"}`);
