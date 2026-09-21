// Runs every *.test.js in this directory in its own process and aggregates.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n━━ ${f} ━━`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? `\nAll ${files.length} suites passed` : `\n${failed} of ${files.length} suites FAILED`);
process.exit(failed === 0 ? 0 : 1);
