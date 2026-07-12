// Host-repo context shared by all kg skill scripts: locating the host root,
// reading .kg/config.yaml, and allocating sequential ids.

import fs from "node:fs";
import path from "node:path";
import { parse } from "./kyaml.mjs";

// The host root is the repo kg was installed into. Resolution order:
//   1. KG_ROOT environment variable;
//   2. nearest ancestor of cwd containing `.kg/`;
//   3. cwd (kg-init runs before `.kg/` exists).
export function findHostRoot(cwd = process.cwd()) {
  if (process.env.KG_ROOT) return path.resolve(process.env.KG_ROOT);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".kg"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

export const CONFIG_DEFAULTS = {
  observation_threshold: 5,
  agents_block_budget_lines: 30,
};

export function loadConfig(hostRoot) {
  const file = path.join(hostRoot, ".kg", "config.yaml");
  if (!fs.existsSync(file)) return { ...CONFIG_DEFAULTS };
  const cfg = parse(fs.readFileSync(file, "utf8"));
  return { ...CONFIG_DEFAULTS, ...cfg };
}

export function kgPaths(hostRoot) {
  const kg = path.join(hostRoot, ".kg");
  return {
    kg,
    config: path.join(kg, "config.yaml"),
    observations: path.join(kg, "observations"),
    processed: path.join(kg, "observations", "processed"),
    queue: path.join(kg, "queue"),
    reports: path.join(kg, "reports"),
    knowledge: path.join(hostRoot, "knowledge"),
    agentsMd: path.join(hostRoot, "AGENTS.md"),
  };
}

export function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => path.join(dir, e.name))
    .sort();
}

// Next OBS-YYYYMMDD-NNN for today, scanning inbox AND processed so ids never
// collide after observations are archived.
export function nextObservationId(paths, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const prefix = `OBS-${day}-`;
  let max = 0;
  for (const dir of [paths.observations, paths.processed]) {
    for (const file of listFiles(dir, ".yaml")) {
      const base = path.basename(file, ".yaml");
      if (base.startsWith(prefix)) max = Math.max(max, Number.parseInt(base.slice(prefix.length), 10) || 0);
    }
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// Next KN-NNNN across all knowledge entries (any lifecycle state).
export function nextKnowledgeId(paths) {
  let max = 0;
  for (const file of listFiles(paths.knowledge, ".md")) {
    const m = /^KN-(\d{4})/.exec(path.basename(file));
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `KN-${String(max + 1).padStart(4, "0")}`;
}

export function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

// --- compile-round action log ------------------------------------------------
// Every publishing script appends what it did to a JSONL scratch file; the
// report-metrics script reads it to compute the subtraction ratio and clears
// it once the compile report is finalized.

export function roundLogFile(paths) {
  return path.join(paths.reports, ".round-actions.jsonl");
}

export function appendRoundAction(paths, action) {
  fs.mkdirSync(paths.reports, { recursive: true });
  fs.appendFileSync(roundLogFile(paths), JSON.stringify({ at: new Date().toISOString(), ...action }) + "\n");
}

export function readRoundActions(paths) {
  const file = roundLogFile(paths);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}
