---
id: KN-0003
claim: "Skill scripts must reach shared code only via the _lib.mjs resolver, and every install mode — checkout, --copy, and registry (npx skills add) — must preserve the lib/../../protocol layout; registry installers copy ONLY the skill directory, so scripts/lib/ and protocol/ are committed vendored inside every skills/<name>/ and scripts/sync-vendored.mjs (--check) guards drift."
category: project_contract
scope:
  paths: ["skills/*/scripts/**", "scripts/lib/**", "protocol/**", scripts/sync-vendored.mjs]
evidence:
  - { type: observation, ref: OBS-20260712-002 }
  - { type: observation, ref: OBS-20260712-004 }
  - { type: observation, ref: OBS-20260713-002 }
  - { type: quote, ref: "scripts/lib/protocol.mjs: PROTOCOL_DIR = LIB_DIR/../../protocol" }
  - { type: diff, ref: "install.mjs --copy embeds scripts/lib and protocol inside each vendored skill dir" }
  - { type: diff, ref: "commit c009c4c: vendored copies committed; skills CLI local-source install verified end-to-end in /tmp/host-npx" }
  - { type: quote, ref: "vercel-labs/skills README: skill discovery walks skills/<name>/SKILL.md and installs the skill dir only" }
authority: formal_decision
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Contract

Two layout invariants keep skills runnable in the plugin checkout, a vendored
(`--copy`) install, and a registry install (`npx skills add`):

1. Every skill script imports shared code through its local `_lib.mjs`
   resolver (candidates: `../../../scripts/lib/`, then `./lib/`). Never
   import `scripts/lib/*` by a hardcoded relative path from a skill script.
2. `protocol/` is resolved as `<lib>/../../protocol`. Any new install mode or
   repo reshuffle must preserve that relationship — this is exactly why
   `--copy` embeds `scripts/lib/` AND `protocol/` inside each skill dir.

## Registry-install consequence

Registry installers (`npx skills add`, per the vercel-labs/skills CLI) walk
`skills/<name>/SKILL.md` and copy ONLY that skill directory. Nothing outside
the skill dir ships. Therefore the vendored `scripts/lib/` and `protocol/`
copies inside every `skills/<name>/` are COMMITTED in this repo — they are
not build artifacts. `scripts/sync-vendored.mjs` regenerates them from the
root source of truth, and its `--check` mode guards drift: any change to
`scripts/lib/**` or `protocol/**` must be followed by a sync run before
commit.

Breaking any of these invariants makes installed skills fail only at the
consumer's site, which is the worst place to discover it.
