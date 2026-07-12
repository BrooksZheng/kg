// The AGENTS.md managed block: single implementation shared by kg-init
// (plants the block) and kg-compile (re-renders it). Everything between the
// anchors is generated from active knowledge entries — never hand-edited.

import fs from "node:fs";
import path from "node:path";
import { splitFrontmatter } from "./protocol.mjs";
import { kgPaths, loadConfig, listFiles, fail } from "./host.mjs";

export const BEGIN = "<!-- kg:begin -->";
export const END = "<!-- kg:end -->";

export function renderBlockLines(hostRoot) {
  const paths = kgPaths(hostRoot);
  const config = loadConfig(hostRoot);
  const skillsPath = String(config.skills_path ?? ".agents/skills").replace(/\/+$/, "");

  const active = [];
  for (const file of listFiles(paths.knowledge, ".md")) {
    let frontmatter;
    try {
      ({ frontmatter } = splitFrontmatter(fs.readFileSync(file, "utf8")));
    } catch (err) {
      fail(`knowledge/${path.basename(file)} is not a valid entry — ${err.message}\n  (every .md under knowledge/ must be a kg entry; move stray files elsewhere)`);
    }
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
    // Defuse HTML comment sequences in claim text so a malicious or unlucky
    // claim cannot terminate/corrupt the managed block's anchors.
    const sanitize = (s) => String(s).replaceAll("<!--", "<! --").replaceAll("-->", "-- >").replace(/\r?\n/g, " ");
    for (const e of active) {
      lines.push(`- ${e.id} [${e.category}] ${sanitize(e.claim)} → \`${e.relPath}\``);
    }
  }
  return { lines, budget: config.agents_block_budget_lines, activeCount: active.length };
}

// Rewrite (or verify, with check=true) the managed block in the host's
// AGENTS.md. Content outside the anchors is never touched. Fails loudly when
// the line budget is exceeded or the anchors are missing/corrupt.
export function applyBlock(hostRoot, { check = false } = {}) {
  const paths = kgPaths(hostRoot);
  const { lines, budget, activeCount } = renderBlockLines(hostRoot);
  if (lines.length > budget) {
    fail(
      `managed block is ${lines.length} lines, budget is ${budget} (.kg/config.yaml agents_block_budget_lines).\n` +
        `  This is the context-bloat alarm: merge/demote entries (subtraction duty) rather than raising the budget.`,
    );
  }
  if (!fs.existsSync(paths.agentsMd)) {
    fail(`${paths.agentsMd} not found — run kg-init first (it plants the anchor block)`);
  }
  const text = fs.readFileSync(paths.agentsMd, "utf8");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < 0) fail(`anchors ${BEGIN} / ${END} not found in AGENTS.md — run kg-init to plant them`);
  if (end < begin) fail("AGENTS.md anchors are out of order");
  if (text.indexOf(BEGIN, begin + 1) >= 0 || text.indexOf(END, end + 1) >= 0) {
    fail("AGENTS.md contains duplicate kg anchors — remove the extra block by hand");
  }

  const rendered = `${BEGIN}\n${lines.join("\n")}\n${END}`;
  const updated = text.slice(0, begin) + rendered + text.slice(end + END.length);
  const stats = `${lines.length}/${budget} lines, ${activeCount} active entr${activeCount === 1 ? "y" : "ies"}`;

  if (check) {
    if (updated !== text) {
      console.error("kg: AGENTS.md managed block is STALE — run render-agents.mjs to update it.");
      process.exit(1);
    }
    console.log(`kg: managed block up to date (${stats})`);
    return;
  }
  if (updated === text) {
    console.log(`kg: managed block already up to date (${stats})`);
    return;
  }
  fs.writeFileSync(paths.agentsMd, updated);
  console.log(`kg: rendered managed block (${stats}) -> ${paths.agentsMd}`);
}
