---
id: KN-0021
claim: "All kg path-isolation guards must compare .kg path segments case-insensitively; a .KG or .kG spelling must be rejected everywhere .kg is."
category: project_knowledge
scope:
  paths:
    - "skills/kg-kickoff/scripts/**"
    - scripts/eval-kickoff.mjs
    - scripts/eval-spec.mjs
evidence:
  - { type: observation, ref: OBS-20260730-002 }
  - { type: test, ref: "R4 regression: gather-context rejected .KG/observations/x.yaml with exit 1" }
authority: machine_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260730-002]
carrier_refs: []
---

## Detail

macOS and Windows filesystems are typically case-insensitive: `.KG/` and
`.kg/` are the same directory on disk, but a case-sensitive string guard
sees them as different and lets the read through. Every isolation guard
(kickoff reads, evaluator file and citation checks, inventory exclusion)
must lowercase each path segment before comparing against `.kg`.

This is enforced by regression tests; when writing a NEW guard, reuse the
shared host helper instead of writing a fresh comparison.
