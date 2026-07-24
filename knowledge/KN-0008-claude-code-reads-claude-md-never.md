---
id: KN-0008
claim: "Claude Code reads CLAUDE.md (never AGENTS.md) and discovers skills under .claude/skills/; kg-init wires both — .claude/skills/kg-* symlinks to the canonical .agents/skills/ copies plus an @AGENTS.md import in CLAUDE.md — but only when the host shows Claude markers (.claude/ dir or CLAUDE.md)."
category: project_knowledge
scope:
  paths: ["skills/kg-init/**"]
evidence:
  - { type: observation, ref: OBS-20260713-005 }
  - { type: quote, ref: "official Claude Code memory docs: Claude Code reads CLAUDE.md, not AGENTS.md; @AGENTS.md import is the recommended bridge" }
  - { type: diff, ref: "install.mjs Claude wiring section, verified against npx skills add -a claude-code layout in /tmp/kg-demo" }
  - { type: test, ref: "2026-07-24: node scripts/test-rfc004.mjs verified kg-scan linkage and @AGENTS.md import in a Claude-marker host" }
authority: current_code_and_schema
confidence: 0.85
lifecycle: active
supersedes: null
last_verified: 2026-07-24
regret: null
---

## Detail

Claude Code has its own discovery surfaces, disjoint from the AGENTS.md
ecosystem:

- **Memory**: it loads `CLAUDE.md`, never `AGENTS.md`. The official bridge is
  an `@AGENTS.md` import line inside `CLAUDE.md`.
- **Skills**: it discovers skills under `.claude/skills/`, not
  `.agents/skills/`.

`kg-init` (the installer's Claude wiring section) wires both surfaces:
`.claude/skills/kg-*`
symlinks pointing at the canonical `.agents/skills/` copies (single source,
no second vendored tree — consistent with the KN-0004 installed-layout
contract), plus the `@AGENTS.md` import in `CLAUDE.md`.

## Conditionality

The wiring is applied ONLY when the host shows Claude markers (a `.claude/`
directory or a `CLAUDE.md` file). Hosts without Claude usage stay clean;
adding Claude later means re-running kg-init.
