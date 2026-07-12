// Move processed observations out of the inbox into
// .kg/observations/processed/. Run at the end of a compile session, AFTER the
// report is written — an observation left in the inbox is by definition not
// yet compiled.
//
// Usage:
//   node skills/kg-compile/scripts/archive-observations.mjs OBS-... [OBS-...]
//   node skills/kg-compile/scripts/archive-observations.mjs --all

import fs from "node:fs";
import path from "node:path";
import { host } from "./_lib.mjs";

const args = process.argv.slice(2);
const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);

let files;
if (args.includes("--all")) {
  files = host.listFiles(paths.observations, ".yaml");
} else {
  const ids = args.filter((a) => !a.startsWith("--"));
  if (ids.length === 0) host.fail("usage: archive-observations.mjs <OBS-id>... | --all");
  files = ids.map((id) => {
    const f = path.join(paths.observations, `${id}.yaml`);
    if (!fs.existsSync(f)) host.fail(`observation not found in inbox: ${id}`);
    return f;
  });
}

if (files.length === 0) {
  console.log("kg: inbox is empty — nothing to archive.");
  process.exit(0);
}

fs.mkdirSync(paths.processed, { recursive: true });
for (const file of files) {
  const dest = path.join(paths.processed, path.basename(file));
  if (fs.existsSync(dest)) host.fail(`already archived: ${path.basename(file)}`);
  fs.renameSync(file, dest);
  console.log(`kg: archived ${path.basename(file, ".yaml")}`);
}
console.log(`kg: ${files.length} observation(s) moved to observations/processed/`);
