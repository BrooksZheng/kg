---
id: KN-0003
claim: "Skill scripts must reach shared code only via the _lib.mjs resolver, and both install modes must preserve the lib/../../protocol layout."
category: project_contract
scope:
  paths: ["skills/*/scripts/**", "scripts/lib/**", "protocol/**"]
evidence:
  - { type: observation, ref: OBS-20260712-002 }
  - { type: observation, ref: OBS-20260712-004 }
  - { type: quote, ref: "scripts/lib/protocol.mjs: PROTOCOL_DIR = LIB_DIR/../../protocol" }
  - { type: diff, ref: "install.mjs --copy embeds scripts/lib and protocol inside each vendored skill dir" }
authority: formal_decision
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-12
regret: null
---

## Contract

Two layout invariants keep skills runnable in both the plugin checkout and a
vendored (`--copy`) install:

1. Every skill script imports shared code through its local `_lib.mjs`
   resolver (candidates: `../../../scripts/lib/`, then `./lib/`). Never
   import `scripts/lib/*` by a hardcoded relative path from a skill script.
2. `protocol/` is resolved as `<lib>/../../protocol`. Any new install mode or
   repo reshuffle must preserve that relationship — this is exactly why
   `--copy` embeds `scripts/lib/` AND `protocol/` inside each skill dir.

Breaking either invariant makes vendored skills fail only at the consumer's
site, which is the worst place to discover it.
