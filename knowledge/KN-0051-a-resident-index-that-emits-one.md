---
id: KN-0051
claim: "A resident index that emits one line per ledger entry cannot coexist with a fixed line budget; the render layer must fold or tier before the ledger outgrows the surface."
category: project_knowledge
scope:
  paths: [AGENTS.md, knowledge/, protocol/scan.yaml]
evidence:
  - { type: observation, ref: OBS-20260805-014 }
  - { type: log, ref: "the v1 managed block listed 18 entries in 30 lines — exactly the resident-surface target, zero headroom — while 47 entries were active; one line per entry would need about 59" }
  - { type: log, ref: "kg-scan against this repository reported 47 legacy_v1_without_v2_trace findings, one per active entry: the block had not been re-rendered since v1" }
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

The budget exists because instruction compliance degrades as the always-on
instruction count grows (KN-0013), so raising it is not an option. A
one-line-per-entry renderer therefore has a hard ceiling on ledger size, and
that ceiling arrives early — this repository crossed it at roughly 20
entries.

The v2 answer is to stop rendering the ledger into the resident surface at
all: `AGENTS.md` carries a hard rule, the project's commands, and which
skill to reach for, while kickoff retrieves the entries a task actually
needs. Any future resident index must fold — by scope, by category, or by
recency — rather than enumerate.
