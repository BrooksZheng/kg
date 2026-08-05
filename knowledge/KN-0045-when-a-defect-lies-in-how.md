---
id: KN-0045
claim: "When a defect lies in how a component interprets a shared contract, the repair belongs in a shared helper the sibling components also call; a local fix leaves every sibling holding the original defect and it reappears in the next one written."
category: project_contract
scope:
  paths: ["scripts/eval-*.mjs", scripts/lib/eval-tool-audit.mjs]
evidence:
  - { type: observation, ref: OBS-20260805-007 }
  - { type: log, ref: "D50: eval-spec matched question-asking tools by substring, so a tool named task counted as ask; fixed locally with word boundaries" }
  - { type: log, ref: "D70: eval-docs counted script invocations by command substring, so an agent reading assess-adr.mjs counted as a fifth invocation and a correct G-DOC1 session was failed — the same misinterpretation of the same tool-event contract, in the fifth evaluator" }
  - { type: test, ref: "test-v2 shared tool-audit regression cases covering read-of-script and filename-in-argument events" }
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

D50 and D70 are one defect at two sites: both read the tool-event contract
as free text and matched substrings, when the contract carries structure
that answers the question exactly. The first repair added word boundaries
inside `eval-spec` and stopped there, so the four other evaluators kept the
original reading and the fifth one written reproduced the bug.

The judgment call is whether a defect is local. Ask what the buggy code was
interpreting. If it was interpreting its own state, the fix is local. If it
was interpreting a contract that siblings also interpret — a tool-event
shape, a protocol record, a path convention — then every sibling holds the
same misreading, and the fix must move to where they all reach it.

Consolidating has a second effect worth the cost: after the merge, the next
occurrence of this class breaks all five evaluators at once. That is
better than the alternative, because a defect that fails everywhere gets
found immediately, while one that fails in the newest component waits for
someone to write a sixth.
