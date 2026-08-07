---
id: KN-0050
claim: "When two spellings denote one location or value, the writer must canonicalize to a single form; accepting both hands downstream checkers two representations of one fact and they reject each other's."
category: project_knowledge
scope:
  paths:
    - protocol/scan-agent-report.schema.yaml
    - scripts/lib/document-anchor.mjs
    - skills/kg-scan/scripts/write-agent-report.mjs
evidence:
  - { type: observation, ref: OBS-20260805-013 }
  - { type: observation, ref: OBS-20260805-015 }
  - { type: log, ref: "G-A1 attempt-02 failed all three deterministic checks with semantically correct findings, only because the agent wrote #L3-L3 where the source-derived oracle produces #L3" }
  - { type: test, ref: "scripts/test-v2.mjs Part 7 scan_agent_writer_canonicalizes_degenerate_line_ranges" }
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

A degenerate range and a single-line anchor mean the same line. Both are
reasonable to write, so an agent will write both, and any checker that
derives its expectation from the source produces exactly one of them. The
mismatch then reads as a semantic failure when the semantics were right.

Canonicalize at the writer, where the fact enters the system, and let the
schema declare which form is canonical so the instruction and the check
cannot drift (KN-0044). Preserve genuinely distinct forms — a true
multi-line range is not the same fact as a single line.
