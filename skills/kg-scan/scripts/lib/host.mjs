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

// Canonicalize existing paths with realpath. When the tail does not exist,
// resolve the deepest existing ancestor and rebuild the missing tail. Both
// sides of every path comparison must use this function.
export function canonicalPath(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function hasPathSegment(target, expected) {
  const wanted = String(expected).toLowerCase();
  return path
    .resolve(target)
    .split(path.sep)
    .filter(Boolean)
    .some((segment) => segment.toLowerCase() === wanted);
}

export function isOutside(root, target) {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(target);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function assertSafeHostRoot(root) {
  const declared = path.resolve(root);
  const canonical = canonicalPath(declared);
  if (hasPathSegment(declared, ".kg") || hasPathSegment(canonical, ".kg")) {
    throw new Error(`host root must not be inside a .kg path: ${declared}`);
  }
  if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) {
    throw new Error(`host root is not a directory: ${declared}`);
  }
  return canonical;
}

export function resolveSafeRelative(root, relative, { mustExist = true, allowSymlink = false, forbidKg = true } = {}) {
  if (typeof relative !== "string" || relative.trim() === "" || path.isAbsolute(relative)) {
    throw new Error(`path must be a non-empty relative path: ${relative}`);
  }
  const portable = relative.replaceAll("\\", "/");
  const rawSegments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (rawSegments.includes("..")) throw new Error(`path escapes root: ${relative}`);
  if (forbidKg && rawSegments.some((segment) => segment.toLowerCase() === ".kg")) {
    throw new Error(`path must not enter .kg: ${relative}`);
  }

  const canonicalRoot = canonicalPath(root);
  const target = path.resolve(canonicalRoot, ...rawSegments);
  if (isOutside(canonicalRoot, target)) throw new Error(`path escapes root: ${relative}`);

  let current = canonicalRoot;
  for (const segment of rawSegments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) break;
      throw error;
    }
    if (!allowSymlink && stat.isSymbolicLink()) throw new Error(`path contains a symbolic link: ${relative}`);
  }

  const canonicalTarget = canonicalPath(target);
  if (isOutside(canonicalRoot, canonicalTarget)) throw new Error(`path resolves outside root: ${relative}`);
  if (forbidKg && hasPathSegment(canonicalTarget, ".kg")) throw new Error(`path resolves through .kg: ${relative}`);
  if (mustExist && !fs.existsSync(target)) throw new Error(`path does not exist: ${relative}`);
  return {
    root: canonicalRoot,
    full: target,
    canonical: canonicalTarget,
    relative: rawSegments.join("/"),
  };
}

export const CONFIG_DEFAULTS = {
  observation_threshold: 5,
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
  if (max + 1 > 999) fail(`observation id space exhausted for ${day} (999/day) — this volume means the pipeline is misused; investigate before recording more`);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// Next KN-NNNN across all knowledge entries (any lifecycle state).
export function nextKnowledgeId(paths) {
  let max = 0;
  for (const file of listFiles(paths.knowledge, ".md")) {
    const m = /^KN-(\d{4})/.exec(path.basename(file));
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  if (max + 1 > 9999) fail("knowledge id space exhausted (KN-9999) — the id format needs a protocol revision, not a silently invalid id");
  return `KN-${String(max + 1).padStart(4, "0")}`;
}

export function knowledgeSlug(claim) {
  return (
    String(claim)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "entry"
  );
}

export function knowledgeFilename(id, claim) {
  if (!/^KN-[0-9]{4}$/.test(id)) throw new Error(`invalid knowledge id: ${id}`);
  return `${id}-${knowledgeSlug(claim)}.md`;
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
