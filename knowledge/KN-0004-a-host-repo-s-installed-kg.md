---
id: KN-0004
claim: "A host repo's installed kg layout is .agents/skills/kg-* self-contained copies only; the root checkout layout (skills/ protocol/ scripts/) belongs exclusively to the plugin source repo."
category: project_contract
scope:
  paths: ["skills/kg-init/**", README.md]
evidence:
  - { type: observation, ref: OBS-20260712-010 }
  - { type: diff, ref: "trial branch cursor/kg-trial-72da cc519e6bd7 - relocated from root checkout layout to .agents/skills vendored layout" }
authority: user_explicit_constraint
confidence: 0.95
lifecycle: candidate
supersedes: null
last_verified: 2026-07-12
regret: null
---

## Contract

Two layouts exist and must never be conflated:

- **Plugin source repo** (development): `skills/`, `protocol/`, `scripts/lib/`
  at the repo root. This is where kg itself is built.
- **Installed host repo** (consumption): everything lives under
  `.agents/skills/kg-*/` as self-contained vendored copies (each skill embeds
  `scripts/lib/` and `protocol/`), produced by `kg-init --copy`. The host
  root gains only `.kg/`, `knowledge/`, the AGENTS.md managed block, and the
  `.cursorignore` line — never the plugin's own source directories.

"Installing kg" into a host by cloning/vendoring the plugin checkout at the
host root is wrong: it clutters the host with source-repo internals and
confused the human on first contact. Distribution UX should converge on
registry-style installs (e.g. `npx skills add kg`) that land skills directly
in `.agents/skills/` — the vendored layout is already that end state.
