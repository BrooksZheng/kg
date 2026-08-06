---
id: KN-0004
claim: "A host repo's installed kg layout is .agents/skills/kg-* self-contained copies only; the root checkout layout (skills/ protocol/ scripts/) belongs exclusively to the plugin source repo."
category: project_contract
scope:
  paths: ["skills/kg-init/**", README.md]
evidence:
  - { type: observation, ref: OBS-20260712-010 }
  - { type: diff, ref: "trial branch cursor/kg-trial-72da cc519e6bd7 - relocated from root checkout layout to .agents/skills vendored layout" }
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §五 permits an optional docs profile in the host root" }
  - { type: observation, ref: OBS-20260806-004 }
  - { type: log, ref: "R6.1: migrate-v1 refused this repository with 'skill source and migration destination resolve to the same directory: kg-init' because .agents/skills/kg-* are symlinks back into skills/" }
authority: user_explicit_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
---

## Contract

Two layouts exist and must never be conflated:

- **Plugin source repo** (development): `skills/`, `protocol/`, `scripts/lib/`
  at the repo root. This is where kg itself is built.
- **Installed host repo** (consumption): everything lives under
`.agents/skills/kg-*/` as self-contained vendored copies (each skill embeds
`scripts/lib/` and `protocol/`), produced by `kg-init --copy`. The host
root gains `.kg/`, `knowledge/`, a short pointer surface in AGENTS.md, the
`.cursorignore` line, and optional direct-authoring files under `docs/`.
It never gains the plugin's own source directories.

The plugin source repo consuming its own skills is the one case where the
two layouts meet, and it resolves to symlinks: `.agents/skills/kg-*` point
back into `skills/`, so the installed copy is the source. Every destructive
operation therefore refuses it — an installer that would replace a skill
directory with itself, a migration whose destination is its own source — and
those refusals are correct (KN-0005). Exercising the migrator against this
repository means reconstructing a v1 host from real copies, migrating that,
and restoring the symlinks afterwards.

"Installing kg" into a host by cloning/vendoring the plugin checkout at the
host root is wrong: it clutters the host with source-repo internals and
confused the human on first contact. Distribution UX should converge on
registry-style installs (e.g. `npx skills add kg`) that land skills directly
in `.agents/skills/` — the vendored layout is already that end state.
