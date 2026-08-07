---
id: KN-0020
claim: "Project-relative allowlist readers must reject raw .. path segments before normalization; normalization can collapse an escaping path into an in-root path and bypass the named-surface boundary."
category: project_knowledge
scope:
  paths:
    - skills/kg-kickoff/scripts/gather-context.mjs
    - skills/kg-spec/scripts/produce-spec.mjs
    - scripts/eval-kickoff.mjs
    - scripts/eval-spec.mjs
evidence:
  - { type: observation, ref: OBS-20260730-001 }
  - { type: diff, ref: "M1 security review added raw segment checks before path.posix.normalize in context gathering, spec anchors, and evaluators" }
authority: current_code_and_schema
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260730-001]
carrier_refs: []
---

## Detail

A reader that allowlists project-relative surfaces (for example
`docs/decisions/*`) and normalizes candidate paths first can be bypassed:
`docs/../.kg/queue/x.yaml` normalizes to `.kg/queue/x.yaml`, which is
in-root and may match a broader check, while the *named surface* boundary
was the actual contract. Ordering matters:

1. Reject any candidate containing a raw `..` segment (split on `/`, compare
   segments — do not substring-match).
2. Only then normalize and test against the allowlist.

Apply this to every new reader that accepts agent- or fixture-supplied
relative paths.
