---
id: KN-0053
claim: "A writer that selects its output version by the presence of an optional flag will silently emit the obsolete shape whenever a caller omits it, so the new surface gets built, documented, and never exercised."
category: project_knowledge
scope:
  paths: [skills/kg-kickoff/scripts/record-turn.mjs]
evidence:
  - { type: observation, ref: OBS-20260806-001 }
  - { type: log, ref: "D73: record-turn fell back to version 1 whenever --session was absent, so every real kickoff session recorded the superseded shape while the skill documented the current one" }
  - { type: test, ref: "scripts/test-v2.mjs record_turn_requires_an_explicit_product_version" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

Version selection by optional flag makes omission mean "old", and omission is
the default state of every caller that has not been updated. The old path
stays warm, the new path stays cold, and the test suite — replaying archived
artifacts of the old shape — reports success.

Make the choice explicit: fail when no version is named. Keep the superseded
path reachable only through a channel a working session cannot discover, such
as an environment variable the test harness sets, so replaying an archive
stays possible without offering a session a way to fall back.
