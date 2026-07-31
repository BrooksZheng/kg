---
id: KN-0001
claim: "Migration preserves v1 knowledge entries without adding v2 trace fields."
category: project_contract
scope:
  paths: ["knowledge/**"]
evidence:
  - { type: test, ref: "M2A migration fixture" }
authority: formal_decision
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
---

## Contract

This v1 entry deliberately omits `source_obs_ids` and `carrier_refs`.
