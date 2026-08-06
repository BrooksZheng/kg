---
id: KN-0055
claim: "An emptiness precheck cannot detect a concurrent run: two processes sharing one output directory both pass it at start, and the first one's output makes the second fail as though the thing under test misbehaved."
category: project_knowledge
scope:
  paths: [scripts/eval-spec.mjs, scripts/eval-kickoff.mjs]
evidence:
  - { type: observation, ref: OBS-20260806-005 }
  - { type: log, ref: "three spec gates failed with 'session ran archive; the evaluator owns the archive step' while no session tool event invoked --archive" }
  - { type: log, ref: "stat birth times showed the archived spec, result.json and runner-output.json sharing one instant 2.5 minutes before the surviving run's final write" }
authority: verified_runtime_behavior
confidence: 0.85
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

The check reads "this directory is empty, so nothing else has run here". What
it actually establishes is that nothing else had *finished* by the time this
process looked. Two runs started together both see an empty directory, and
the losing one then reads the winner's artifacts as evidence about its own
session.

The misdiagnosis is the expensive part: the failure names a rule the session
supposedly broke, and the transcript disproves it only if someone thinks to
check the birth times. Where a gate owns a directory, it should claim it —
an exclusive create, a lock file, or a per-run unique path.
