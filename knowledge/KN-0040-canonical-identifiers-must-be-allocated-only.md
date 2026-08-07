---
id: KN-0040
claim: "Canonical identifiers must be allocated only after full preflight and persisted as a reservation bound to the plan digest, context digest, allocation range, and timestamp, so an interrupted run resumes onto the same identifiers instead of minting new ones."
category: project_knowledge
scope:
  paths:
    - skills/kg-compile/scripts/apply-compile-plan.mjs
    - scripts/lib/compile-plan.mjs
evidence:
  - { type: observation, ref: OBS-20260804-002 }
  - { type: test, ref: "test-v2 Part 4 compile_multi_publish_is_preflight_atomic" }
  - { type: test, ref: "test-v2 Part 4 compile_multi_publish_reservation_resumes_without_new_ids" }
  - { type: test, ref: "test-v2 Part 4 compile_multi_publish_ids_are_deterministic_under_plan_order_variation" }
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

Two constraints that look like one. Allocating after preflight keeps a
plan that fails validation from consuming identifiers, so a rejected plan
leaves no gap in the sequence. Persisting the reservation before any
product mutation keeps a crash between allocation and write from minting a
second set on resume.

The reservation binds to both the plan digest and the context digest, so
resuming with a modified plan or against a moved baseline is refused
rather than silently re-allocated.

Ordering within the allocation comes from the protocol's disposition rank,
not from the order the agent happened to write plan items. Two plans with
identical content and shuffled item order produce identical identifiers —
otherwise the identifier records how the plan was typed rather than what
it contains.

Distinct from KN-0024, which governs terminal-state idempotence: a resumed
run can reach the correct terminal state while still having burned a fresh
identifier along the way.
