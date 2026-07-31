---
id: KN-0023
claim: "Evidence line references must bind to the inventory-time source snapshot: record per-file hashes at inventory and revalidate them before rendering, so source edits cannot silently retarget facts."
category: project_knowledge
scope:
  paths:
    - scripts/lib/repository.mjs
    - skills/kg-docs/scripts/bootstrap.mjs
evidence:
  - { type: observation, ref: OBS-20260731-001 }
  - { type: test, ref: "node scripts/test-v2.mjs --part 2 case reject_source_drift_after_inventory" }
authority: machine_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-001]
carrier_refs: []
---

## Detail

A `path#L12` evidence anchor is only meaningful against the bytes that were
read when the fact was extracted. If the source file changes between
inventory and rendering, the same line number can point at different
content and a "fact" silently becomes a fabrication.

Pattern: the inventory records a sha256 per file; every consumer of an
evidence anchor (bootstrap renderer, plan validator) recomputes the hash
immediately before writing output and refuses on mismatch. Apply the same
snapshot-binding rule to any future pipeline that carries line-anchored
evidence across steps.
