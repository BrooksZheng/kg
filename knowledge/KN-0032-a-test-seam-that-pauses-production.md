---
id: KN-0032
claim: "A test seam that pauses production code must be inert when unconfigured, signal readiness outside the system under test, and pause only after the production step completes — proven by asserting the unset run and the released run reach byte-identical terminal state."
category: project_knowledge
scope:
  paths:
    - skills/kg-init/scripts/migration-lib.mjs
    - scripts/kill-migration-at-checkpoint.mjs
evidence:
  - { type: observation, ref: OBS-20260731-022 }
  - { type: test, ref: "test-v2 Part 1 kill_matrix_converges_at_every_checkpoint: eleven SIGKILL checkpoints plus an unset-seam versus released-seam terminal tree equality assertion" }
authority: machine_constraint
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-03
regret: null
source_obs_ids: [OBS-20260731-022]
carrier_refs: []
---

## Detail

Interrupting a real process at a precise moment requires a hook inside
production code, which is exactly the kind of hook that quietly becomes a
second code path. Four properties keep it honest:

1. **Inert by default.** The first statement reads the environment variable
   and returns when it is absent — no file, no poll, no timer.
2. **Signals outside the system under test.** The ready and release files
   must live outside the host being mutated, or the seam becomes part of
   the state it is supposed to observe.
3. **Pauses after, never instead.** The checkpoint sits behind the
   production write it names, so the paused state is a real intermediate
   state rather than a synthetic one.
4. **Equivalence is asserted, not assumed.** A test compares the terminal
   tree of an unset-seam run against a released-seam run; identical bytes
   prove the seam changed nothing but timing.

Driving the kill from a ready-file handshake (not a sleep) is what makes
the interruption point deterministic; timing is only a failure timeout.
