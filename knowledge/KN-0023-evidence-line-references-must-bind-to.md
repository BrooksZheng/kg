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
  - { type: observation, ref: OBS-20260803-002 }
  - { type: test, ref: "node scripts/test-v2.mjs --part 2 case reject_source_drift_after_inventory" }
  - { type: test, ref: "node scripts/test-v2.mjs --part 2 case proposal_rejects_target_drift" }
authority: machine_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-08-03
regret: null
source_obs_ids: [OBS-20260731-001, OBS-20260803-002]
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

The same binding governs a **mutable target**, not just a source: a
content-addressed proposal derives its identity partly from the target's
hash, so the target must be revalidated twice — once while preparing the
candidate, and again immediately before mutation. One check alone leaves a
time-of-check-to-time-of-use window in which an old plan would happily
attach its candidate to a target that has since changed.
