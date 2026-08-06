---
id: KN-0057
claim: "Agent-assisted review artifacts — evidence packets and agent reports — must resolve outside the host project root, so that reviewing a repository can never write into it."
category: project_contract
scope:
  paths:
    - skills/kg-scan/scripts/agent-report-core.mjs
    - skills/kg-scan/scripts/prepare-agent-evidence.mjs
    - skills/kg-scan/scripts/write-agent-report.mjs
evidence:
  - { type: observation, ref: OBS-20260805-012 }
  - { type: diff, ref: "agent-report-core.mjs rejects a canonical output path inside project_root" }
  - { type: test, ref: "scripts/test-v2.mjs Part 7 scan_agent_report_is_separate_and_hash_binds_deterministic_report rejects a host-internal output" }
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

kg-scan reads a repository and says what has rotted. Read-only is the whole
of its safety argument, and an output path defaulting into the repository
quietly breaks it: the review leaves artifacts in the thing being reviewed,
which then show up in the next inventory as material to review.

The rule is enforced at the writer, on the canonical path, so a symlink or a
`..` cannot smuggle the output back inside. Session artifacts belong in a
session directory the caller names, outside the host root.
