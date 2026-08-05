---
id: KN-0047
claim: "The existence of a signal file is not the signal; a waiter must block until the file's contents equal the awaited value, because creation and the write of the confirming bytes are two separate events."
category: project_knowledge
scope:
  paths: [scripts/kill-migration-at-checkpoint.mjs]
evidence:
  - { type: observation, ref: OBS-20260805-009 }
  - { type: log, ref: "R5.3: the checkpoint kill driver woke on the ready file's existence and killed the child before the checkpoint bytes were durable, so the kill landed at an earlier point than the test intended" }
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

The producer creates the ready file, then writes which checkpoint it
reached. A waiter polling for the path wakes up in between and reads either
an empty file or a stale one from a previous checkpoint.

The bug is unusually mean in a test harness. It does not fail — it kills at
some other checkpoint and the test still runs, still passes or fails for
reasons unrelated to what it was written to probe. A kill matrix that
believes it covered eleven checkpoints may have covered the same early one
eleven times, and the evidence of thoroughness is exactly as strong as it
would be if the coverage were real.

Wait on content, not existence: poll until the file parses and its value
equals the awaited checkpoint. The same reasoning applies to any
out-of-band signal whose payload arrives after its container.
