---
id: KN-0054
claim: "A template that requires N labeled slots must let a slot declare itself empty; an exact-label match forces a repository with no such command to either invent one or fail validation."
category: project_knowledge
scope:
  paths: [skills/kg-init/scripts/migration-lib.mjs, AGENTS.md]
evidence:
  - { type: observation, ref: OBS-20260806-003 }
  - { type: log, ref: "detect-migration reported V2_AGENTS_INVALID when this repository's Commands comments read 构建（无构建步骤…）, because the validator compared the label for equality with 构建" }
authority: verified_runtime_behavior
confidence: 0.8
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

The three-slot Commands block earns its place by telling a reader what to run
for build, test and lint without hunting. A repository with no build step
still owes the reader that slot — "no build step, scripts run directly" is an
answer, and a far better one than a slot quietly missing.

Requiring the keyword while allowing a qualifier after it keeps the structure
machine-checkable and lets the content be honest. A validator that only
accepts the bare keyword converts a truthful project into an invalid one.
