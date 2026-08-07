---
id: KN-0035
claim: "A check must not derive its expected value from the same source as the thing it checks; verdicts come from independently re-read raw bytes or from protocol data, never from the renderer's own output or a mapping duplicated alongside it."
category: project_contract
scope:
  paths:
    - "scripts/eval-*.mjs"
    - "skills/kg-scan/scripts/**"
    - scripts/lib/harness.mjs
    - scripts/test-v2.mjs
evidence:
  - { type: observation, ref: OBS-20260803-005 }
  - { type: log, ref: "R2.2 D35: migration validated installed skills against the same inventory it built them from, so a source missing scripts/lib and protocol installed clean and reported success" }
  - { type: log, ref: "R4.3: kg-scan recomputes every carrier hash from re-read bytes and recomputes proposal target hashes from disk, so a manifest that attests to its own correctness still fails" }
  - { type: test, ref: "test-v2 Part 7 scan_reports_registered_document_schema_failures_deterministically" }
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

A self-consistent check is worse than no check: it costs the same to run,
reports green, and buys nothing. Every instance in this project had the
same shape — the verifier reached for the value that was closest to hand,
and the closest value was the one the producer had just written.

The test is mechanical. Ask what would have to be wrong for the check to
fail, and if the answer is "the producer would have to disagree with
itself", the check is self-attesting. A hash that a manifest carries proves
nothing about the file it names; recompute it from the file. A coverage
verdict read off the renderer's output proves nothing about coverage;
derive it from `protocol/document-taxonomy.yaml` and the documents on disk.

This is also why evaluation oracles are never regenerated in the same round
as the code they judge without a byte-level diff being recorded (R-2).
