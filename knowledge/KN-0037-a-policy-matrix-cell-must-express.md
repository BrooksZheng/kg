---
id: KN-0037
claim: "A policy matrix cell must express exactly one dimension; conflating which region an actor may write with whether it may write directly let human-owned documents map to whole-target writes, and the fix is to keep region in the matrix and derive write mode from the update policy."
category: project_knowledge
scope:
  paths:
    - protocol/routing.yaml
    - skills/kg-compile/scripts/apply-compile-plan.mjs
evidence:
  - { type: observation, ref: OBS-20260803-008 }
  - { type: log, ref: "R4.1 D66: ownership_update_matrix cell for human/human_only read whole_target, which authorized compile to overwrite an entire human-owned document — the exact outcome the ownership model exists to prevent" }
  - { type: test, ref: "test-v2 Part 4 human_owned_carrier_grants_compile_no_region" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

The matrix was indexed by ownership and update policy, and its cells were
asked to answer two questions at once: what may compile write, and how may
it write. `human_only` meant "only a human decides", but the cell holding
`whole_target` was read as a region grant. Nothing was mistyped; the cell
simply could not say "the whole document, but not by you".

Split it. Cells now carry only the compile-owned region —
`machine_block`, `machine_segment`, `whole_target`, `none`, or `reject` —
and write mode comes from `update_policy` alone. `human/human_only` maps
to `none`.

`none` and `reject` must stay distinct. `none` is a legal configuration
where compile has nothing to write and proposes instead; `reject` is a
configuration that should never have been authored. Collapsing them would
make every human-owned carrier look like a config error.
