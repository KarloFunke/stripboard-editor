#!/usr/bin/env node
// Guards the hand-written markdown twins in data/agentDocs.ts against drifting
// from the pages they mirror. Nothing can check that prose still says the same
// thing, so this hashes the visible text of each source page: change the copy
// and the check fails, asking you to review the twin. Styling and code changes
// do not trip it.
//
//   node scripts/checkAgentDocs.js            verify
//   node scripts/checkAgentDocs.js --update   re-record after updating a twin
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// twin in data/agentDocs.ts -> page whose visible text it mirrors
const PAIRS = [
  ["GUIDE_MD", "app/guide/page.tsx"],
  ["AUTO_LAYOUT_MD", "app/how-auto-layout-works/page.tsx"],
  ["INDEX_MD", "app/HomeClient.tsx"],
  ["PRIVACY_MD", "app/privacy/page.tsx"],
  // UPDATES_MD is generated from data/updates.ts, so it cannot drift.
];

const root = path.join(__dirname, "..");
const store = path.join(__dirname, "agentDocs.hashes.json");

/** The words a reader sees: JSX tags, attributes and expressions removed. */
function visibleText(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const hashes = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {};
const update = process.argv.includes("--update");
const stale = [];
let changed = false;

for (const [twin, page] of PAIRS) {
  const hash = crypto.createHash("sha256").update(visibleText(fs.readFileSync(path.join(root, page), "utf8"))).digest("hex").slice(0, 16);
  if (update || !hashes[twin]) {
    changed = changed || hashes[twin] !== hash;
    hashes[twin] = hash;
  } else if (hashes[twin] !== hash) {
    stale.push({ twin, page });
  }
}

if (changed) fs.writeFileSync(store, JSON.stringify(hashes, null, 2) + "\n");

if (update) {
  console.log("Recorded " + PAIRS.length + " page hashes.");
  process.exit(0);
}
if (stale.length) {
  console.error("Markdown twins may be out of date:\n");
  for (const s of stale) {
    console.error("  " + s.page + " changed");
    console.error("    -> review " + s.twin + " in data/agentDocs.ts, then: npm run check:agent-docs -- --update\n");
  }
  process.exit(1);
}
console.log("Markdown twins match their pages (" + PAIRS.length + " checked).");
