// RFC-002 S3: assemble the full AGENTS.md from section → source mapping
// (protocol/agents-sections.yaml). Code-export sections are computed at
// render time (zero copy); intent/convention sections come from knowledge.

import fs from "node:fs";
import path from "node:path";
import { splitFrontmatter, loadAgentsSections } from "./protocol.mjs";
import { kgPaths, loadConfig, fail, CONFIG_DEFAULTS } from "./host.mjs";
import {
  BEGIN,
  END,
  loadActiveEntries,
  renderRootBlockLines,
  applyScopedBlocks,
} from "./agents-block.mjs";

const DOCUMENT_PREAMBLE =
  "# Project context\n\n" +
  "_Rendered by kg — do not edit by hand. Supply changes via knowledge entries, " +
  "observations, or `protocol/agents-sections.yaml`; re-run render-agents.mjs._\n";

function enforceBudget(sectionId, lines, budget) {
  if (lines.length > budget) {
    fail(
      `section \`${sectionId}\` is ${lines.length} lines, budget is ${budget}.\n` +
        `  Rescope content or raise the section budget in protocol/agents-sections.yaml.`,
    );
  }
}

function exportNodeRepoLayout(hostRoot) {
  const rows = [
    ["skills/", "agent skills (kg-init, kg-observe, kg-compile)"],
    ["protocol/", "schemas, lifecycle, routing, domains"],
    ["scripts/lib/", "shared Node modules — source of truth"],
    ["knowledge/", "compiled knowledge entries"],
    [".kg/", "pipeline state (never read during work tasks)"],
    ["docs/", "RFC and design docs"],
  ];
  const lines = ["```text"];
  for (const [dir, desc] of rows) {
    if (fs.existsSync(path.join(hostRoot, dir))) lines.push(`${dir.padEnd(16)}${desc}`);
  }
  lines.push("```");
  return lines;
}

function renderIntentSection(hostRoot, section) {
  const intent = loadActiveEntries(hostRoot).filter((e) => e.scope?.domains?.includes("intent"));
  if (!intent.length) return [];
  const lines = [section.heading, ""];
  for (const e of intent) lines.push(`- ${e.claim}`);
  enforceBudget(section.id, lines, section.budget_lines);
  return lines;
}

function renderConventionSection(hostRoot, section) {
  const contracts = loadActiveEntries(hostRoot).filter((e) => e.category === "project_contract");
  if (!contracts.length) return [];
  const lines = [section.heading, ""];
  for (const e of contracts) {
    const file = path.join(hostRoot, e.relPath);
    const { body } = splitFrontmatter(fs.readFileSync(file, "utf8"));
    const excerpt = body
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .slice(0, 8)
      .join("\n");
    lines.push(`### ${e.id}`, "", excerpt, "");
  }
  enforceBudget(section.id, lines, section.budget_lines);
  return lines;
}

function renderKgManagedBlock(hostRoot) {
  const config = loadConfig(hostRoot);
  const { lines, budget } = renderRootBlockLines(hostRoot);
  enforceBudget("kg_index", lines, config.agents_block_budget_lines ?? CONFIG_DEFAULTS.agents_block_budget_lines);
  return [`${BEGIN}`, ...lines, `${END}`];
}

function renderSection(hostRoot, section) {
  switch (section.source) {
    case "intent_entries":
      return renderIntentSection(hostRoot, section);
    case "code_export":
      if (section.exporter === "node_repo_layout") {
        const lines = [section.heading, "", ...exportNodeRepoLayout(hostRoot)];
        enforceBudget(section.id, lines, section.budget_lines);
        return lines;
      }
      fail(`unknown code_export exporter: ${section.exporter}`);
    case "convention_entries":
      return renderConventionSection(hostRoot, section);
    case "kg_managed_block":
      return renderKgManagedBlock(hostRoot);
    default:
      fail(`unknown section source: ${section.source}`);
  }
}

export function assembleAgentsDocument(hostRoot) {
  const spec = loadAgentsSections();
  const parts = [DOCUMENT_PREAMBLE.trimEnd()];
  for (const section of spec.sections) {
    const lines = renderSection(hostRoot, section);
    if (!lines.length && section.optional) continue;
    parts.push("", ...lines);
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

// Render the full AGENTS.md (RFC-002 S3) plus scoped subdirectory blocks.
export function applyDocument(hostRoot, { check = false } = {}) {
  const paths = kgPaths(hostRoot);
  const rendered = assembleAgentsDocument(hostRoot);
  const { activeCount, sunkByDir, lines, budget } = renderRootBlockLines(hostRoot);
  let ok = true;

  if (!fs.existsSync(paths.agentsMd)) {
    if (check) {
      console.error(`kg: ${paths.agentsMd} missing — run kg-init first.`);
      ok = false;
    } else {
      fs.writeFileSync(paths.agentsMd, rendered);
      console.log(`kg: created ${paths.agentsMd} (full rendered document)`);
    }
  } else {
    const current = fs.readFileSync(paths.agentsMd, "utf8");
    if (check) {
      if (current !== rendered) {
        console.error("kg: AGENTS.md is STALE — run render-agents.mjs to update the full document.");
        ok = false;
      }
    } else if (current === rendered) {
      console.log("kg: AGENTS.md already up to date (full document)");
    } else {
      fs.writeFileSync(paths.agentsMd, rendered);
      console.log(`kg: rendered full AGENTS.md -> ${paths.agentsMd}`);
    }
  }

  const scoped = applyScopedBlocks(hostRoot, { check, sunkByDir });
  if (!scoped.ok) ok = false;

  const stats = `${lines.length}/${budget} index lines, ${activeCount} active entr${activeCount === 1 ? "y" : "ies"}, ${scoped.scopedCount} scoped block${scoped.scopedCount === 1 ? "" : "s"}`;

  if (check) {
    if (!ok) process.exit(1);
    console.log(`kg: document and scoped blocks up to date (${stats})`);
    return;
  }
  console.log(`kg: render complete (${stats})`);
}
