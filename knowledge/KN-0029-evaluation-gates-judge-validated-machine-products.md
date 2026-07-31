---
id: KN-0029
claim: "Evaluation gates judge validated machine products and tool events only; they must never infer pass or fail from the wording of agent prose."
category: project_contract
scope:
  paths:
    - scripts/eval-kickoff.mjs
    - scripts/eval-spec.mjs
    - scripts/eval-compile.mjs
    - scripts/eval-bootstrap.mjs
evidence:
  - { type: observation, ref: OBS-20260730-004 }
  - { type: diff, ref: "scripts/eval-kickoff.mjs auditMustReport validates the bounded kg.kickoff_conflicts product and source_path coverage instead of scanning prose" }
  - { type: quote, ref: ".mission/kg-v2-refactor/contract-3.md §10.1.8: 判据检查机器产物与事件，不扫描 agent 自由散文的词、子串或固定句式。" }
authority: formal_decision
confidence: 0.9
lifecycle: candidate
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260730-004]
carrier_refs: []
---

## Detail

Prose scanning fails in both directions: a session that did the work but
phrased it unexpectedly fails (false negative), and a session that merely
claims the work passes (false positive). D50 later reproduced the same
family inside tool-event scanning (substring "ask" matched "task").

The binding rule for every gate, current and future:

- Pass/fail evidence comes from validated machine products
  (`kg.kickoff_conflicts`, `kg.spec_synthesis`, plans, reports) and from
  successful tool events in the Runner Contract envelope.
- Agent free text is for humans; at most it is cross-checked for byte
  identity against a recorded product field (for example `question_text`),
  never mined with keywords, substrings, or fixed phrasings.
