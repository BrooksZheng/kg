---
id: KN-0002
claim: "Compile-managed runbooks must preserve human text outside their managed block."
category: project_knowledge
scope:
  paths: ["docs/runbooks/**"]
evidence:
  - { type: observation, ref: OBS-20260731-101 }
authority: verified_runtime_behavior
confidence: 1
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-101]
carrier_refs:
  - "HAR-COMPILE-NOTES@docs/runbooks/compile-notes.md#kg:managed"
---

## Constraint

Managed carrier updates replace only the uniquely identified marker content.
