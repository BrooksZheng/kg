---
id: KN-0052
claim: "Saved-fixture replay cannot detect that a writer and its checker have drifted apart, because the frozen artifact and the frozen contract are the same vintage; only a live session runs the current writer against the current checker."
category: project_knowledge
scope:
  paths:
    - scripts/test-v2.mjs
    - scripts/eval-kickoff.mjs
    - skills/kg-kickoff/scripts/record-turn.mjs
evidence:
  - { type: observation, ref: OBS-20260805-017 }
  - { type: log, ref: "D72: all three fresh kickoff sessions failed while the six-fixture replay stayed green — the saved fixtures held version 1 turn products and the evaluator asserted version === 1, so replay compared an old artifact against an old contract" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

A replay suite answers "does the checker still accept what the writer used to
produce". That is a useful question, and it is not the question anyone
believes the suite is answering. When the writer moves to a new product
shape, the fixtures do not move with it, so the pair under test is
consistently one generation old and consistently green.

Keep replay for regression against archived artifacts, and treat a live
session as the only evidence that the current writer and current checker
agree. Where a suite must cover the current shape, it has to generate the
artifact in the run rather than read one from disk.
