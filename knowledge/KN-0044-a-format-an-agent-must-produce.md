---
id: KN-0044
claim: "A format an agent must produce may be stated in exactly one authoritative place; when prose documentation restates a format the schema enforces, the two drift and the agent follows the doc into a validator rejection."
category: project_contract
scope:
  paths:
    - "skills/*/SKILL.md"
    - "protocol/**"
    - "skills/*/references/**"
evidence:
  - { type: observation, ref: OBS-20260805-004 }
  - { type: log, ref: "D54: kg-spec SKILL.md documented bare project-relative paths for archive constraint sources while the task-spec schema and archive validator required stable #L line anchors; the agent followed the prose and failed validation" }
  - { type: log, ref: "R5.3 repaired the SKILL text; the divergence had survived since M2 because nothing compared the two statements" }
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

This is KN-0034 applied to the documentation surface, and it needs its own
treatment because the mechanism differs. Code can read a protocol table at
runtime; prose cannot. So the second statement must either be generated
from the schema or checked against it, and if neither is practical, the
prose should point at the schema instead of restating it.

The failure is quiet in a way that pure code drift is not. The agent does
exactly what it was told, produces a well-formed artifact, and fails at the
validator — where the error message describes the schema's expectation and
gives no hint that a document told it otherwise. Debugging starts in the
wrong place.

Prefer pointing over restating (KN-0012): a SKILL that says "constraint
sources use the anchor form required by `protocol/task-spec.schema.yaml`"
cannot drift, while one that spells out the form can.
