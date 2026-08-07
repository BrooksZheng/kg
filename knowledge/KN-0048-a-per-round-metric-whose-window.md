---
id: KN-0048
claim: "A per-round metric whose window is cleared by a separate discretionary command will silently span rounds; the reset must be tied to the round-closing action rather than left as a flag someone remembers to run."
category: project_knowledge
scope:
  paths: [skills/kg-compile/scripts/report-metrics.mjs, .kg/reports/]
evidence:
  - { type: observation, ref: OBS-20260805-010 }
  - { type: log, ref: "report-metrics printed 'subtraction ratio this round: 0/14' while the round had added 6; the action log still held the previous round's 8 adds because --clear-round was never run, and nothing in the report signalled a wrong window" }
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

A round metric answers "what happened this round". Its truthfulness rests
entirely on when the window was last cleared, and that is the one thing the
number does not show. When clearing is an opt-in flag on the same tool that
prints the metric, the failure is silent in both directions: a forgotten
reset inflates the denominator with a previous round's work, and the report
looks the same either way.

Bind the reset to the action that ends the round — writing the report — or
make the metric state its window explicitly so a reader can see the span
being claimed. A number whose window is unstated is not a measurement.
