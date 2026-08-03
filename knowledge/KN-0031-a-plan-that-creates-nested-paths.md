---
id: KN-0031
claim: "A plan that creates nested paths must explicitly own every absent ancestor directory, because recursive creation silently produces directories no plan operation declared and rollback then cannot restore the exact source tree."
category: project_knowledge
scope:
  paths: [skills/kg-init/scripts/migration-lib.mjs]
evidence:
  - { type: observation, ref: OBS-20260731-020 }
  - { type: test, ref: "test-v2 Part 1 rollback_restores_verified_v1_before_images" }
  - { type: log, ref: "R3.2 D59: after a positive rollback the tree differed from the v1 baseline by exactly one empty harness/ directory, created implicitly by recursive mkdir of harness/artifacts" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-03
regret: null
source_obs_ids: [OBS-20260731-020]
carrier_refs: []
---

## Detail

`mkdirSync(p, { recursive: true })` creates every missing ancestor. If the
plan only declared `harness/artifacts`, then `harness/` exists afterwards
with no operation, no ownership, and no rollback entry — the reverse
operation leaves it behind and the "restored" tree is not byte-equal to the
original.

Rule: enumerate absent ancestors at plan time and give each its own create
operation, so ownership sets stay closed and rollback deletes them in
reverse order. The same reasoning applies to any ownership-partitioned
mutation, not just migration: an implicitly created object is an unowned
object.
