---
id: KN-0046
claim: "Backward-compatibility shims for older saved artifacts belong in the evaluator's preflight adapter, not in the product writer; a writer that accepts two versions makes the current contract unenforceable at the only place it can be enforced."
category: project_knowledge
scope:
  paths:
    - skills/kg-spec/scripts/produce-spec.mjs
    - scripts/eval-spec.mjs
evidence:
  - { type: observation, ref: OBS-20260805-008 }
  - { type: test, ref: "test-v2 Part 6 validate_synthesis_and_archive_share_one_protocol_validator" }
  - { type: diff, ref: "R5.3: archive accepts only canonical v3 synthesis bound to packet bytes; saved v2 replay moved to evaluator-owned preflight" }
authority: verified_runtime_behavior
confidence: 0.85
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

Saved v2 fixtures still had to replay after synthesis moved to v3. The
tempting fix is to let the archive writer accept both, which costs one
branch and keeps the old tests green.

It also means the writer no longer enforces anything. Every future caller
can emit v2, the branch stays warm forever, and the reason it exists —
three saved fixtures from a previous milestone — is invisible at the call
site. The v2 path outlives its purpose by default, because nothing marks
when it is safe to remove.

Put the shim in the evaluator's preflight instead. It upgrades a saved v2
artifact to canonical v3 and hands the writer exactly one shape. The
writer's contract stays single-valued, the compatibility window is visible
in evaluator code where its scope is obvious, and deleting it later means
deleting one adapter rather than proving no caller still needs a branch.
