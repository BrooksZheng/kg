// Render the kg managed block in the host's AGENTS.md from ACTIVE knowledge
// entries. Everything between the anchors is generated — never hand-edit it;
// edit the knowledge entries and re-render.
//
// Usage:
//   node skills/kg-compile/scripts/render-agents.mjs           # rewrite block
//   node skills/kg-compile/scripts/render-agents.mjs --check   # verify only
//
// Block layout (resident lines + index):
//   <!-- kg:begin -->  ... <!-- kg:end -->
//   - the .kg/ read-isolation HARD RULE (main defense, RFC 5.6)
//   - observe / compile skill pointers
//   - one index line per active entry
// Budget: agents_block_budget_lines from .kg/config.yaml counts every line
// between the anchors (exclusive). Exceeding it FAILS LOUDLY — that is the
// context-bloat alarm: merge or demote entries instead of raising the budget.

import fs from "node:fs";
import path from "node:path";
import { protocol, host } from "./_lib.mjs";

export const BEGIN = "<!-- kg:begin -->";
export const END = "<!-- kg:end -->";

export function renderBlockLines(hostRoot) {
  const paths = host.kgPaths(hostRoot);
  const config = host.loadConfig(hostRoot);
  const skillsPath = (config.skills_path ?? ".agents/skills").replace(/\/+$/, "");

  const active = [];
  for (const file of host.listFiles(paths.knowledge, ".md")) {
    const { frontmatter } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
    if (frontmatter.lifecycle === "active") {
      active.push({ ...frontmatter, relPath: path.relative(hostRoot, file) });
    }
  }
  active.sort((a, b) => a.id.localeCompare(b.id));

  const lines = [
    "kg (Project Knowledge Growth) — managed block, rendered from `knowledge/`. Do not edit by hand.",
    "",
    "- HARD RULE: never read `.kg/` during a work task — it holds uncompiled claims and pipeline state. Writes go only through the kg-observe skill; reads happen only inside kg-compile sessions.",
    `- Record observations (task end, or IMMEDIATELY on human correction): \`${skillsPath}/kg-observe/SKILL.md\`.`,
    `- Compile pending observations into knowledge: \`${skillsPath}/kg-compile/SKILL.md\`.`,
  ];
  if (active.length) {
    lines.push("", "Active project knowledge (read the entry before working in its scope):", "");
    for (const e of active) {
      lines.push(`- ${e.id} [${e.category}] ${e.claim} → \`${e.relPath}\``);
    }
  }
  return { lines, budget: config.agents_block_budget_lines, activeCount: active.length };
}

export function currentBlock(agentsText) {
  const begin = agentsText.indexOf(BEGIN);
  const end = agentsText.indexOf(END);
  if (begin < 0 || end < 0) return null;
  if (end < begin) throw new Error("AGENTS.md anchors are out of order");
  return { begin, end };
}

function main() {
  const check = process.argv.includes("--check");
  const hostRoot = host.findHostRoot();
  const paths = host.kgPaths(hostRoot);

  const { lines, budget, activeCount } = renderBlockLines(hostRoot);
  if (lines.length > budget) {
    host.fail(
      `managed block is ${lines.length} lines, budget is ${budget} (.kg/config.yaml agents_block_budget_lines).\n` +
        `  This is the context-bloat alarm: merge/demote entries (subtraction duty) rather than raising the budget.`,
    );
  }

  if (!fs.existsSync(paths.agentsMd)) {
    host.fail(`${paths.agentsMd} not found — run kg-init first (it plants the anchor block)`);
  }
  const text = fs.readFileSync(paths.agentsMd, "utf8");
  const span = currentBlock(text);
  if (!span) host.fail(`anchors ${BEGIN} / ${END} not found in AGENTS.md — run kg-init to plant them`);

  const rendered = `${BEGIN}\n${lines.join("\n")}\n${END}`;
  const updated = text.slice(0, span.begin) + rendered + text.slice(span.end + END.length);

  if (check) {
    if (updated !== text) {
      console.error("kg: AGENTS.md managed block is STALE — run render-agents.mjs to update it.");
      process.exit(1);
    }
    console.log(`kg: managed block up to date (${lines.length}/${budget} lines, ${activeCount} active entr${activeCount === 1 ? "y" : "ies"})`);
    return;
  }
  if (updated === text) {
    console.log(`kg: managed block already up to date (${lines.length}/${budget} lines)`);
    return;
  }
  fs.writeFileSync(paths.agentsMd, updated);
  console.log(`kg: rendered managed block (${lines.length}/${budget} lines, ${activeCount} active entr${activeCount === 1 ? "y" : "ies"}) -> ${paths.agentsMd}`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
