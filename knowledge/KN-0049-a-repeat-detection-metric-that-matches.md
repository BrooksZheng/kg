---
id: KN-0049
claim: "A repeat-detection metric that matches only one signal source under-reports the phenomenon it exists to catch; count repeats across every source that can carry the same recurrence."
category: project_knowledge
scope:
  paths: [skills/kg-compile/scripts/report-metrics.mjs]
evidence:
  - { type: observation, ref: OBS-20260805-011 }
  - { type: log, ref: "D50 (eval-spec substring match) and D70 (eval-docs substring match) are the same misreading of the same tool-event contract five evaluators apart, yet report-metrics printed repeat-correction count 0 because both were recorded as task_outcome, not human_correction" }
authority: verified_runtime_behavior
confidence: 0.8
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

The repeat-correction count was defined as human corrections matching an
earlier human correction. In a project whose defects are mostly found by
tests and gates rather than by a human noticing, that definition excludes
almost every real repeat, and the metric reads zero while the phenomenon it
was built to expose keeps happening.

The measurement error is worse than no metric: a zero is read as evidence
that repeats do not occur. When a metric is meant to detect recurrence, the
match set must span the sources through which recurrence actually arrives —
here `task_outcome` and `agent_insight` as well as `human_correction`.
