// The AGENTS.md managed block: single implementation shared by kg-init
// (plants the block) and kg-compile (re-renders it). Everything between the
// anchors is generated from active knowledge entries — never hand-edited.
//
// RFC-002 S1: layered index — contracts at root, path-scoped knowledge/
// procedure sink to subdirectory blocks, pathless entries fold by domain,
// sunk domains leave pointer rows at root.

import fs from "node:fs";
import path from "node:path";
import { splitFrontmatter } from "./protocol.mjs";
import { kgPaths, loadConfig, listFiles, fail, CONFIG_DEFAULTS } from "./host.mjs";

export const BEGIN = "<!-- kg:begin -->";
export const END = "<!-- kg:end -->";

const SINKABLE = new Set(["project_knowledge", "procedure"]);
const ROOT_CONTRACT = new Set(["project_contract", "executable_constraint"]);

function sanitizeClaim(s) {
  return String(s).replaceAll("<!--", "<! --").replaceAll("-->", "-- >").replace(/\r?\n/g, " ");
}

function loadActiveEntries(hostRoot) {
  const paths = kgPaths(hostRoot);
  const active = [];
  for (const file of listFiles(paths.knowledge, ".md")) {
    let frontmatter;
    try {
      ({ frontmatter } = splitFrontmatter(fs.readFileSync(file, "utf8")));
    } catch (err) {
      fail(
        `knowledge/${path.basename(file)} is not a valid entry — ${err.message}\n` +
          `  (every .md under knowledge/ must be a kg entry; move stray files elsewhere)`,
      );
    }
    if (frontmatter.lifecycle === "active") {
      active.push({ ...frontmatter, relPath: path.relative(hostRoot, file) });
    }
  }
  active.sort((a, b) => a.id.localeCompare(b.id));
  return active;
}

// Derive a host-relative directory from a scope path pattern.
function sinkDirFromPattern(pattern) {
  let p = String(pattern);
  const globIdx = p.search(/[*?[]/);
  if (globIdx >= 0) p = p.slice(0, globIdx).replace(/\/+$/, "");
  if (!p || p === ".") return null;
  const base = path.posix.basename(p);
  if (base.includes(".") && !base.startsWith(".")) {
    let dir = path.posix.dirname(p);
    if (dir.endsWith("/scripts") || dir.endsWith("/lib")) dir = path.posix.dirname(dir);
    return dir === "." ? null : dir;
  }
  return p;
}

function entrySinkDir(entry) {
  if (!SINKABLE.has(entry.category)) return null;
  const paths = entry.scope?.paths;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  return sinkDirFromPattern(paths[0]);
}

function primaryDomain(entry) {
  const domains = entry.scope?.domains;
  if (!Array.isArray(domains) || domains.length === 0) return "_unassigned";
  return domains[0];
}

function classifyEntries(active) {
  const rootContracts = [];
  const folded = [];
  const sunkByDir = new Map();

  for (const entry of active) {
    if (ROOT_CONTRACT.has(entry.category)) {
      rootContracts.push(entry);
      continue;
    }
    if (!SINKABLE.has(entry.category)) continue;

    const sinkDir = entrySinkDir(entry);
    if (sinkDir) {
      const bucket = sunkByDir.get(sinkDir) ?? [];
      bucket.push(entry);
      sunkByDir.set(sinkDir, bucket);
    } else {
      folded.push(entry);
    }
  }

  return { rootContracts, folded, sunkByDir };
}

function renderResidentHeader(config) {
  const skillsPath = String(config.skills_path ?? ".agents/skills").replace(/\/+$/, "");
  return [
    "kg (Project Knowledge Growth) — managed block, rendered from `knowledge/`. Do not edit by hand.",
    "",
    "- HARD RULE: never read `.kg/` during a work task — it holds uncompiled claims and pipeline state. Writes go only through the kg-observe skill; reads happen only inside kg-compile sessions.",
    `- Record observations (task end, or IMMEDIATELY on human correction): \`${skillsPath}/kg-observe/SKILL.md\`.`,
    `- Compile pending observations into knowledge: \`${skillsPath}/kg-compile/SKILL.md\`.`,
  ];
}

function renderRootBlockLines(hostRoot) {
  const config = loadConfig(hostRoot);
  const active = loadActiveEntries(hostRoot);
  const { rootContracts, folded, sunkByDir } = classifyEntries(active);

  const lines = renderResidentHeader(config);

  if (rootContracts.length || folded.length || sunkByDir.size) {
    lines.push("", "Active project knowledge (read the entry before working in its scope):", "");
  }

  for (const e of rootContracts) {
    lines.push(`- ${e.id} [${e.category}] ${sanitizeClaim(e.claim)} → \`${e.relPath}\``);
  }

  if (folded.length) {
    const byDomain = new Map();
    for (const e of folded) {
      const d = primaryDomain(e);
      const bucket = byDomain.get(d) ?? [];
      bucket.push(e);
      byDomain.set(d, bucket);
    }
    for (const [domain, entries] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const refs = entries.map((e) => `${e.id} → \`${e.relPath}\``).join("; ");
      lines.push(`- [${domain}] ${refs}`);
    }
  }

  if (sunkByDir.size) {
    const pointers = [];
    for (const [sinkDir, entries] of [...sunkByDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const domains = [...new Set(entries.map(primaryDomain))].sort();
      const domainLabel = domains.join("+");
      const agentsRel = path.posix.join(sinkDir, "AGENTS.md");
      const n = entries.length;
      pointers.push({ domainLabel, agentsRel, n, sinkDir });
    }
    for (const { domainLabel, agentsRel, n } of pointers) {
      lines.push(`- [${domainLabel}] → \`${agentsRel}\` (${n} entr${n === 1 ? "y" : "ies"})`);
    }
  }

  return {
    lines,
    budget: config.agents_block_budget_lines,
    activeCount: active.length,
    sunkByDir,
  };
}

function renderSubdirBlockLines(entries, sinkDir) {
  const lines = [
    `kg scoped index — knowledge/procedure entries for \`${sinkDir}/\`. Do not edit by hand.`,
    "",
    "Read the entry file before working in this scope:",
    "",
  ];
  for (const e of entries) {
    lines.push(`- ${e.id} [${e.category}] ${sanitizeClaim(e.claim)} → \`${e.relPath}\``);
  }
  return lines;
}

function applyBlockAtFile(filePath, lines, budget, label, { check = false } = {}) {
  if (lines.length > budget) {
    fail(
      `${label} is ${lines.length} lines, budget is ${budget}.\n` +
        `  This is the context-bloat alarm: merge/demote/rescope entries rather than raising the budget.`,
    );
  }

  const rendered = `${BEGIN}\n${lines.join("\n")}\n${END}`;

  if (!fs.existsSync(filePath)) {
    if (check) {
      console.error(`kg: ${filePath} missing — run render-agents.mjs to create it.`);
      return false;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${rendered}\n`);
    console.log(`kg: created ${filePath} with managed block (${lines.length}/${budget} lines)`);
    return true;
  }

  const text = fs.readFileSync(filePath, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < 0) {
    if (check) {
      console.error(`kg: anchors missing in ${filePath} — run render-agents.mjs to plant them.`);
      return false;
    }
    const sep = text.endsWith("\n") ? "\n" : "\n\n";
    const updated = `${text}${sep}${rendered}\n`;
    fs.writeFileSync(filePath, updated);
    console.log(`kg: appended managed block to ${filePath} (${lines.length}/${budget} lines)`);
    return true;
  }
  if (end < begin) fail(`AGENTS.md anchors are out of order in ${filePath}`);
  if (text.indexOf(BEGIN, begin + 1) >= 0 || text.indexOf(END, end + 1) >= 0) {
    fail(`${filePath} contains duplicate kg anchors — remove the extra block by hand`);
  }

  const updated = text.slice(0, begin) + rendered + text.slice(end + END.length);

  if (check) {
    if (updated !== text) {
      console.error(`kg: managed block STALE in ${filePath} — run render-agents.mjs to update it.`);
      return false;
    }
    return true;
  }

  if (updated === text) {
    console.log(`kg: managed block already up to date in ${filePath} (${lines.length}/${budget} lines)`);
    return true;
  }
  fs.writeFileSync(filePath, updated);
  console.log(`kg: rendered managed block (${lines.length}/${budget} lines) -> ${filePath}`);
  return true;
}

// Rewrite (or verify, with check=true) the managed block in the host's
// AGENTS.md and every subdirectory block derived from sunk entries.
export function applyBlock(hostRoot, { check = false } = {}) {
  const paths = kgPaths(hostRoot);
  const config = loadConfig(hostRoot);
  const subdirBudget = config.agents_block_budget_lines_subdir ?? CONFIG_DEFAULTS.agents_block_budget_lines_subdir;

  const { lines, budget, activeCount, sunkByDir } = renderRootBlockLines(hostRoot);
  let ok = true;

  if (!fs.existsSync(paths.agentsMd)) {
    fail(`${paths.agentsMd} not found — run kg-init first (it plants the anchor block)`);
  }

  if (!applyBlockAtFile(paths.agentsMd, lines, budget, "root managed block", { check })) {
    ok = false;
  }

  for (const [sinkDir, entries] of [...sunkByDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const subLines = renderSubdirBlockLines(entries, sinkDir);
    const subFile = path.join(hostRoot, sinkDir, "AGENTS.md");
    if (!applyBlockAtFile(subFile, subLines, subdirBudget, `scoped block for ${sinkDir}`, { check })) {
      ok = false;
    }
  }

  const stats = `${lines.length}/${budget} root lines, ${activeCount} active entr${activeCount === 1 ? "y" : "ies"}, ${sunkByDir.size} scoped block${sunkByDir.size === 1 ? "" : "s"}`;

  if (check) {
    if (!ok) process.exit(1);
    console.log(`kg: all managed blocks up to date (${stats})`);
    return;
  }
  console.log(`kg: render complete (${stats})`);
}

// Exported for tests and render-agents.mjs stats; kept name-compatible.
export function renderBlockLines(hostRoot) {
  const { lines, budget, activeCount } = renderRootBlockLines(hostRoot);
  return { lines, budget, activeCount };
}

