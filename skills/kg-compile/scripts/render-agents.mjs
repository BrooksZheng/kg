// Render the kg managed block in the host's AGENTS.md from ACTIVE knowledge
// entries. Everything between the anchors is generated — never hand-edit it;
// edit the knowledge entries and re-render.
//
// Usage:
//   node skills/kg-compile/scripts/render-agents.mjs           # rewrite block
//   node skills/kg-compile/scripts/render-agents.mjs --check   # verify only
//
// Block layout (resident lines + index):
//   - the .kg/ read-isolation HARD RULE (main defense, RFC 5.6)
//   - observe / compile skill pointers
//   - one index line per active entry
// Budget: agents_block_budget_lines from .kg/config.yaml counts every line
// between the anchors (exclusive). Exceeding it FAILS LOUDLY — that is the
// context-bloat alarm: merge or demote entries instead of raising the budget.

import { host, agentsBlock } from "./_lib.mjs";

agentsBlock.applyBlock(host.findHostRoot(), { check: process.argv.includes("--check") });
