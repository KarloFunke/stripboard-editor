// Put a solved project (from v5Solve --save) into the dev database for a user.
//   node tests/solver/saveToDev.js <project.json> [--user karlo] [--db ../backend/db.sqlite3]
const { spawnSync } = require("child_process");
const path = require("path");
const args = process.argv.slice(2);
const file = path.resolve(args[0]);
const argVal = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const user = argVal("user") ?? "karlo";
const db = path.resolve(argVal("db") ?? path.join(__dirname, "../../../backend/db.sqlite3"));
const sql = `
INSERT INTO projects_project (edit_uuid, view_uuid, name, data, created_at, updated_at, fork_of_id, owner_id)
SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))),
       json_extract(readfile('${file}'), '$.name'), readfile('${file}'),
       strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'), NULL, id
FROM auth_user WHERE username = '${user}';
SELECT id, name FROM projects_project ORDER BY id DESC LIMIT 1;`;
const r = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
console.log(`saved for ${user} in ${db}: project ${r.stdout.trim()}`);
