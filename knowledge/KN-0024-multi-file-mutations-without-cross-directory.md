---
id: KN-0024
claim: "Multi-file mutations without cross-directory transactions must bind every planned action to before and after fingerprints and keep completion markers idempotent, so an interrupted run resumes to the same terminal state without duplicate outputs."
category: project_knowledge
scope:
  paths:
    - skills/kg-init/scripts/migration-lib.mjs
    - skills/kg-compile/scripts/apply-compile-plan.mjs
    - skills/kg-compile/scripts/archive-observations.mjs
evidence:
  - { type: observation, ref: OBS-20260731-003 }
  - { type: observation, ref: OBS-20260731-005 }
  - { type: test, ref: "test-v2 Part 1 migration_v1_minimal_preserves_assets mixed-state resume" }
  - { type: test, ref: "test-v2 Part 3 transaction_manifest_resumes_after_mutation_interruptions" }
authority: machine_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-003, OBS-20260731-005]
carrier_refs: []
---

## Detail

POSIX filesystems give no transaction across directories, so any pipeline
that mutates several surfaces (migration: skills + config + AGENTS;
compile: KN + carrier + sidecar + processed + report) can die mid-way.
Two instances of the same cure landed in v2:

1. **Fingerprint-bound actions**: the plan/manifest records each action's
   expected `before` and `after` content hashes. On resume, an action whose
   target equals `after` is done; equals `before` is re-runnable; anything
   else is drift and stops the run.
2. **Idempotent completion**: archival and report writes are keyed by
   deterministic identity (observation id, writer-owned temp names), so
   re-running a completed step produces zero new files, IDs, or duplicates.

Any new multi-surface writer must follow the same two rules rather than
inventing its own recovery.
