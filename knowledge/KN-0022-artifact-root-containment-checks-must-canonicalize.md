---
id: KN-0022
claim: "Artifact-root containment checks must canonicalize both the root and the candidate through their deepest realpath-resolvable ancestors before comparison, while checking the declared path separately for symbolic links."
category: project_knowledge
scope:
  paths: [scripts/eval-kickoff.mjs, scripts/eval-spec.mjs]
evidence:
  - { type: observation, ref: OBS-20260730-006 }
  - { type: test, ref: "R9 regressions: an absolute /tmp product under /tmp/kg-m1-eval7/kickoff passed after canonicalization, while true escape, symlink escape, internal symlink, .KG, and missing-file cases retained their required failures" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260730-006]
carrier_refs: []
---

## Detail

On macOS `/tmp` is a symlink to `/private/tmp`, so a lexical
prefix-containment check between a declared `/tmp/...` root and a
canonicalized candidate (or vice versa) produces false escapes or false
containment. The two comparisons must be separated:

- **Containment / identity**: resolve BOTH sides through their deepest
  realpath-resolvable ancestor (files may not exist yet — resolve the
  nearest existing ancestor, then rejoin the tail), then compare.
- **Symlink policy**: inspect the *declared* path component-by-component so
  that symlinks below the root still fail the policy even though their
  canonical form would be contained.

Same canonical-identity defect family as KN-0005 (destructive refresh) and
KN-0018 (relative symlink targets).
