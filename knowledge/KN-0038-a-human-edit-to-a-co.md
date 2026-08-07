---
id: KN-0038
claim: "A human edit to a co-managed document means different things inside and outside a transaction: between sessions it is a legitimate refresh recorded as a new hash, while inside one transaction the previously read bytes must match byte-for-byte or the write aborts."
category: project_knowledge
scope:
  paths: [scripts/lib/harness.mjs, scripts/test-v2.mjs]
evidence:
  - { type: observation, ref: OBS-20260803-006 }
  - { type: test, ref: "test-v2 Part 4 human_edit_between_sessions_is_refresh_not_tamper" }
  - { type: diff, ref: "scripts/lib/harness.mjs: humanSegmentHashState and assertTransactionByteFence" }
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

`human_segment_hash` is informational across sessions. Treating a changed
value as tampering would mean any human editing their own half of a
co-managed document breaks the next compile — the document is co-managed
precisely so they can.

Within a single transaction the same divergence is fatal. Preflight read
the human bytes, the plan was built against them, and if those bytes moved
before the write lands, the plan is stale and the write aborts.

So the hash is a cross-session observation and the byte fence is an
in-transaction invariant. Same field, two scopes; a single comparison
serving both would either lock humans out of their own segments or let
compile write against a tree it never read.
