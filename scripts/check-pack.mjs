#!/usr/bin/env node
/* Assert the published tarball's contents exactly.
 *
 * `npm pack --dry-run` only previews; it asserts nothing, so it stayed green
 * while package.json#files silently omitted the docs the README links to.
 * This compares the real file list against an explicit allowlist and fails on
 * anything missing or unexpected — the invariants that matter being: the docs
 * ship, and no ETIM model data ever does. */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/* The COMPLETE expected file set. Not a prefix allowlist: "anything under
   docs/" would have accepted an accidental docs/etim.json — model data in the
   published tarball, which is the one thing that must never ship. Adding a
   file to the package means adding it here, deliberately. */
const EXPECTED = new Set([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "server.json",
  "docs/TOOLS.md",
  "docs/FORMAT.md",
]);

/* dist/ is generated, so its exact membership is derived from src/ rather
   than restated: every .ts file must yield .js + .d.ts (+ maps). */
function expectedDist() {
  const out = new Set();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".ts")) {
        const base = `dist/${prefix}${entry.name.slice(0, -3)}`;
        for (const ext of [".js", ".js.map", ".d.ts", ".d.ts.map"]) out.add(base + ext);
      }
    }
  };
  walk("src", "");
  return out;
}

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const files = JSON.parse(raw)[0].files.map((f) => f.path);

const expected = new Set([...EXPECTED, ...expectedDist()]);
const problems = [];

for (const need of expected) {
  if (!files.includes(need)) problems.push(`MISSING: ${need}`);
}
for (const f of files) {
  if (!expected.has(f)) problems.push(`UNEXPECTED (add it to scripts/check-pack.mjs if intended): ${f}`);
}

console.log(`packed ${files.length} files`);
if (problems.length > 0) {
  console.error("\nTarball contents are wrong:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`tarball contents verified against an exact ${expected.size}-file manifest`);
