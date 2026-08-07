---
id: KN-0043
claim: "An index must enumerate every declared source before any budget applies; a budget may drop optional metadata but must preserve source identity, tail entries, counts, and an independently reproducible omission digest — otherwise later sources vanish behind a single global truncation flag."
category: project_knowledge
scope:
  paths:
    - skills/kg-kickoff/scripts/gather-context.mjs
    - protocol/kickoff-index.schema.yaml
evidence:
  - { type: observation, ref: OBS-20260805-003 }
  - { type: observation, ref: OBS-20260805-006 }
  - { type: test, ref: "test-v2 Part 5 kickoff_index_enumerates_tail_entries_without_body_budget_starvation" }
  - { type: test, ref: "test-v2 Part 5 kickoff_index_reports_explicit_exclusions_and_omission_digest" }
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

The old index read document bodies to extract metadata and stopped
enumerating when a shared byte budget ran out. One oversized document
sorted early could therefore consume the budget and make every later
eligible source disappear, reported as a single global `truncated: true`.
A reader could not tell whether three sources were omitted or three
hundred, nor which.

Two phases, not one. Enumeration is cheap and must be complete: every
source the protocol declares gets an entry with its identity. Metadata
enrichment is expensive and may be cut, but the cut is recorded per entry.

The omission digest must be reproducible from the same inputs by someone
who did not run the index, which is what makes it evidence rather than a
claim. A truncation flag that only the producer can interpret says nothing.
