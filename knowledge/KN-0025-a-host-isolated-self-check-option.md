---
id: KN-0025
claim: "A host-isolated self-check option must branch before host-root discovery, and unknown CLI options must be rejected instead of silently falling through to live-data code paths."
category: project_knowledge
scope:
  paths: [skills/kg-observe/scripts/validate-observations.mjs]
evidence:
  - { type: observation, ref: OBS-20260731-004 }
  - { type: test, ref: "scripts/test-v2.mjs: validator_self_check_is_host_isolated" }
authority: machine_constraint
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260731-004]
carrier_refs: []
---

## Detail

A `--self-check` that runs after `findHostRoot()` is not a self-check: it
reads the real inbox as a side effect, and a typo'd option
(`--self-chek`) that is ignored silently degrades into a live run. Two
rules for every kg CLI:

1. Pure self-test modes exit before any host discovery or filesystem read
   outside the script's own fixtures.
2. Argument parsers reject unknown options loudly; "unrecognized flag" must
   never mean "default behavior".
