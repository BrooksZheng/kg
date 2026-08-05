---
id: KN-0001
claim: "Orders API retries must reuse the original idempotency key."
category: project_contract
scope:
  paths: ["services/orders/**", "docs/api/orders.md"]
evidence:
  - { type: test, ref: "orders retry fixture" }
authority: verified_runtime_behavior
confidence: 1
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

The retry boundary is active.
