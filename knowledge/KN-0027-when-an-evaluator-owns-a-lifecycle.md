---
id: KN-0027
claim: "When an evaluator owns a lifecycle step with a fixed clock, the real-session prompt must explicitly forbid the agent from running that step; prompt silence invites the agent to take it and corrupts the evaluation."
category: project_knowledge
scope:
  paths: [scripts/eval-spec.mjs, scripts/eval-kickoff.mjs]
evidence:
  - { type: observation, ref: OBS-20260731-016 }
  - { type: test, ref: "test-v2 Part 6 rejects a session-created TASK archive with the evaluator ownership message" }
  - { type: log, ref: ".mission/kg-v2-refactor/host-findings-r25.md D53" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-016]
carrier_refs: []
---

## Detail

D53: the spec gate reserves the archive step for the evaluator (it controls
the clock and asserts `docs/specs` is empty post-session), but the prompt
never said so — a competent agent read the SKILL, saw `--archive` as the
documented next step, and ran it. The session failed for doing what the
docs teach.

Rule for every real-session gate: enumerate the steps the evaluator owns
and state them as explicit prohibitions in the prompt. Design gates so
that agent-visible documentation and gate expectations never diverge
silently. Applies directly to the M3 G-B3/G-B4 prompts.
