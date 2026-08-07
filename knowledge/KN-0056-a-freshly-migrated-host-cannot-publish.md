---
id: KN-0056
claim: "A freshly migrated host cannot publish its first carrier through the product: the apply step requires an existing harness sidecar and managed target, and no entrypoint authors one."
category: project_knowledge
scope:
  paths:
    - skills/kg-compile/scripts/apply-compile-plan.mjs
    - harness/artifacts/
evidence:
  - { type: observation, ref: OBS-20260806-007 }
  - { type: log, ref: "compile.mjs on this repository returned artifacts: [] after migration, so no publish_kn_and_carrier item could name an artifact_id" }
  - { type: quote, ref: "apply-compile-plan.mjs resolves artifact.sidecar_path from the compile context and fails when it is absent; kg-compile ships no carrier-creation script" }
authority: verified_runtime_behavior
confidence: 0.85
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

Carrier publishing assumes a carrier already exists — a target document with
managed markers plus a harness sidecar whose hashes match it. That holds for
a host whose documents were bootstrapped with carriers, and not for a host
that just migrated from v1, whose `harness/artifacts/` is empty.

Until an entrypoint creates the first carrier, such a host has two honest
routes: publish entries without a carrier through `add-entry.mjs`, or author
the target document and sidecar by hand before compiling. The gap is in the
tooling, not in the model.
