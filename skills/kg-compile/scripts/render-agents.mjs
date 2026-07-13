// Render the full AGENTS.md (RFC-002 S3) from section mapping + knowledge,
// then scoped subdirectory blocks where allowed.
//
// Usage:
//   node skills/kg-compile/scripts/render-agents.mjs           # rewrite
//   node skills/kg-compile/scripts/render-agents.mjs --check   # verify only
//
// The entire AGENTS.md is a rendered product — never hand-edit it; edit
// knowledge entries, observations, or protocol/agents-sections.yaml and
// re-render. Code-export sections are computed at render time (--check
// detects drift). The kg managed block inside uses layered index (S1).

import { host, agentsAssembler } from "./_lib.mjs";

agentsAssembler.applyDocument(host.findHostRoot(), { check: process.argv.includes("--check") });
