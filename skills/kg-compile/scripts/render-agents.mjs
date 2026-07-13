// Render the kg managed block in the host's AGENTS.md from ACTIVE knowledge
// entries. Everything between the anchors is generated — never hand-edit it;
// edit the knowledge entries and re-render.
//
// Usage:
//   node skills/kg-compile/scripts/render-agents.mjs           # rewrite block
//   node skills/kg-compile/scripts/render-agents.mjs --check   # verify only
//
// Block layout (RFC-002 S1 layered index):
//   - the .kg/ read-isolation HARD RULE (main defense, RFC 5.6)
//   - observe / compile skill pointers
//   - project_contract lines (full claim) at root
//   - domain-folded rows for pathless knowledge/procedure
//   - pointer rows for sunk domains -> subdirectory AGENTS.md
//   - path-scoped knowledge/procedure in per-scope subdirectory blocks
// Budget: agents_block_budget_lines (root) and agents_block_budget_lines_subdir
// from .kg/config.yaml. Exceeding either FAILS LOUDLY — merge/demote/rescope
// instead of raising the budget.

import { host, agentsBlock } from "./_lib.mjs";

agentsBlock.applyBlock(host.findHostRoot(), { check: process.argv.includes("--check") });
