---
id: KN-0026
claim: "In-session recorder scripts must enforce the same deterministic rules as the downstream evaluation gate, so an agent fails at record time with an actionable error instead of failing the gate after the session."
category: project_knowledge
scope:
  paths:
    - skills/kg-kickoff/scripts/record-turn.mjs
    - scripts/eval-kickoff.mjs
evidence:
  - { type: observation, ref: OBS-20260731-010 }
  - { type: test, ref: "node scripts/test-v2.mjs --part 5: record_turn_rejects_agent_envelope_fields_and_validates_semantics" }
  - { type: log, ref: ".mission/kg-v2-refactor/host-findings-r24.md D44" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-010]
carrier_refs: []
---

## Detail

D44: `record-turn` accepted findings whose `source_path` was absent from
the context index, and the session only failed later at the C9 gate — the
agent had no chance to repair. Asymmetric strictness between a recorder
and its gate converts recoverable in-session errors into whole-session
failures.

Rule: when adding a gate check on a recorded product, add the same check
(same normalization, same membership rule) to the recorder, passing the
recorder whatever inputs it needs (for example `--index`). The gate keeps
authoritative re-audit; the recorder gives early, actionable failure.
