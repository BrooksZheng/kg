---
id: KN-0034
claim: "Any table that code branches on — rank orders, accepted versions, thresholds, policy matrices — must be read from its protocol file at runtime rather than re-declared in code, because a second declaration drifts silently: both copies look correct in isolation and only a case that crosses them fails."
category: project_contract
scope:
  paths: ["protocol/**", "scripts/lib/**", "skills/*/scripts/**"]
evidence:
  - { type: observation, ref: OBS-20260803-007 }
  - { type: observation, ref: OBS-20260803-009 }
  - { type: observation, ref: OBS-20260804-001 }
  - { type: log, ref: "R4.2 D68: apply-compile-plan wrote version 2 journals while loadJournal hardcoded version === 1; every v2 journal was unreadable and re-entrancy was silently broken. Unit tests missed it because the v1 resume test used a v1 plan, so neither copy was ever exercised against the other." }
  - { type: test, ref: "test-v2 Part 4 v2_transaction_journal_resumes_and_revalidates" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

Three separate M4 rounds landed the same shape. `disposition_rank` and the
ownership matrix moved into `protocol/routing.yaml` so preflight has one
table (R4.1). Accepted journal versions moved into
`protocol/compile-plan.schema.yaml` as `version` plus `legacy_versions`
(R4.2 D68). The resident-surface line budget moved into
`protocol/scan.yaml` (R4.3 A-4).

D68 is the instructive failure. The writer and the reader each held a
correct-looking version constant, and both passed their own tests. The
defect only surfaced in a real session that wrote with one and read with
the other. A hardcoded copy of a protocol table is not a shortcut with a
maintenance cost — it is a defect that has not been triggered yet, because
nothing in the type system or the test suite forces the two declarations to
meet.

Rule: the protocol file is the only place a table is written down. Code
reads it. `scripts/lib/protocol.mjs` self-check asserts cross-file
coherence for tables that must agree across schemas.
