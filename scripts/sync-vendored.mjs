// Vendor the shared lib and protocol into every skill directory so each
// skills/<name>/ is fully self-contained. Registry-style installers
// (`npx skills add`) copy ONLY the skill directory, so the vendored copies
// must be committed and kept in sync with the root source of truth:
//
//   scripts/lib/  ->  skills/<name>/scripts/lib/
//   protocol/     ->  skills/<name>/protocol/
//
// The _lib.mjs resolver prefers the root copy in the plugin checkout, so the
// vendored copies are inert during development — they only matter to
// consumers who received a lone skill directory.
//
// Usage:
//   node scripts/sync-vendored.mjs            # refresh vendored copies
//   node scripts/sync-vendored.mjs --check    # exit 1 if any copy drifted

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const SKILL_NAMES = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("kg-"))
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, "SKILL.md")))
  .sort();
const SOURCES = [
  { src: path.join(ROOT, "scripts", "lib"), destRel: path.join("scripts", "lib") },
  { src: path.join(ROOT, "protocol"), destRel: "protocol" },
];
const checkMode = process.argv.includes("--check");

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

// Canonical path identity (see KN-0005): realpath when the path exists,
// lexical resolve as the fallback — a destructive refresh must never be
// allowed to collapse onto its own source through a symlink alias.
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function listFilesRecursive(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function diffDirs(src, dest) {
  const srcFiles = listFilesRecursive(src);
  const destFiles = listFilesRecursive(dest);
  const problems = [];
  for (const f of srcFiles) {
    if (!destFiles.includes(f)) problems.push(`missing ${f}`);
    else if (!fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(dest, f)))) problems.push(`stale ${f}`);
  }
  for (const f of destFiles) {
    if (!srcFiles.includes(f)) problems.push(`extra ${f}`);
  }
  return problems;
}

let drifted = 0;
for (const name of SKILL_NAMES) {
  for (const { src, destRel } of SOURCES) {
    if (!fs.existsSync(src)) fail(`source missing: ${src}`);
    const dest = path.join(ROOT, "skills", name, destRel);
    const relDest = path.relative(ROOT, dest);
    if (canonical(src) === canonical(dest)) fail(`source and destination are the same directory: ${src}`);
    const problems = diffDirs(src, dest);
    if (problems.length === 0) {
      console.log(`kg: ${relDest} in sync`);
      continue;
    }
    drifted += 1;
    if (checkMode) {
      console.error(`kg: ${relDest} DRIFTED — ${problems.join(", ")}`);
    } else {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      console.log(`kg: refreshed ${relDest} (${problems.length} difference${problems.length === 1 ? "" : "s"})`);
    }
  }
}

// The per-skill _lib.mjs resolvers must stay byte-identical; kg-init's copy is
// the canonical one.
const canonicalLibResolver = path.join(ROOT, "skills", "kg-init", "scripts", "_lib.mjs");
for (const name of SKILL_NAMES.filter((n) => n !== "kg-init")) {
  const dest = path.join(ROOT, "skills", name, "scripts", "_lib.mjs");
  const relDest = path.relative(ROOT, dest);
  if (fs.existsSync(dest) && fs.readFileSync(canonicalLibResolver).equals(fs.readFileSync(dest))) {
    console.log(`kg: ${relDest} in sync`);
    continue;
  }
  drifted += 1;
  if (checkMode) {
    console.error(`kg: ${relDest} DRIFTED from skills/kg-init/scripts/_lib.mjs`);
  } else {
    fs.copyFileSync(canonicalLibResolver, dest);
    console.log(`kg: refreshed ${relDest} from skills/kg-init/scripts/_lib.mjs`);
  }
}

if (checkMode && drifted > 0) {
  console.error(`kg: ${drifted} vendored cop${drifted === 1 ? "y" : "ies"} out of sync — run: node scripts/sync-vendored.mjs`);
  process.exit(1);
}
