---
id: KN-0042
claim: "Retrieval scope must carry a machine-verifiable authorization basis for each selected source; without one, 'this document is relevant' is an unfalsifiable assertion and the read set has no boundary a checker can enforce."
category: project_contract
scope:
  paths:
    - "skills/kg-kickoff/scripts/**"
    - protocol/kickoff-scope.schema.yaml
evidence:
  - { type: observation, ref: OBS-20260805-002 }
  - { type: test, ref: "test-v2 Part 5 kickoff_scope_requires_machine_verifiable_selection_basis" }
  - { type: test, ref: "test-v2 Part 5 kickoff_deep_reads_exact_scope_set_and_rejects_extra_paths" }
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

Deep retrieval used to accept any indexed path the caller named. Nothing
was wrong with the paths it read; the problem was that no checker could
ever say a read was out of bounds, because there was no bound.

The fix is not to make a script judge natural-language relevance — no
general script can. It is to require that each selected source cite a
reason whose basis is reconstructible: a path quoted verbatim in the task
or a human message, a KN scope intersecting a confirmed task path, a docs
map edge, a harness graph edge, or a transcript pointer to a human
confirming a domain. Agent-invented domains, title similarity, and
`relevant: true` are rejected.

When the index offers only a semantic hint and none of those bases exist,
the honest move is to ask the user and record the answer, not to
manufacture a rationale. That keeps the boundary real instead of
pretending to an inference capability the code does not have.

Deep then reads exactly the scope set — no extra paths — so what was read,
why it was allowed, and whether anything escaped are all machine-decidable.
