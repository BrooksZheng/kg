---
id: KN-0009
claim: "Knowledge entries stay atomic — one claim per entry; fragmentation is treated at the render layer, and merge is reserved for true duplication or supersession, never topical aggregation."
category: project_contract
scope:
  paths: ["knowledge/**", "skills/kg-compile/**"]
evidence:
  - { type: observation, ref: OBS-20260713-006 }
  - { type: quote, ref: "human: 那肯定是后者 — choosing section-level precision when asked what should happen if one section of an aggregated thick doc proves wrong" }
  - { type: quote, ref: "docs/rfc-002-agents-md-compiled-artifact.md R1 (confirmed 2026-07-13)" }
authority: formal_decision
confidence: 0.9
lifecycle: candidate
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Contract

When the knowledge base grows and the AGENTS.md index feels fragmented, the
fix lives in the RENDER layer (folding, sinking, tiered budgets — RFC-002),
never in the storage layer:

- One entry = one claim. Lifecycle, evidence, authority, and regret attach at
  claim precision; aggregating related claims into a thick document coarsens
  all four (one wrong section taints the whole doc, regret attribution
  blurs, dedupe degrades to topic matching).
- `merge` (archive with `--superseded-by`) is legal ONLY for true duplication
  or supersession — two entries stating the same claim, or a newer entry
  replacing an older one. "These entries are about the same topic" is NOT
  grounds for merging.

## Rejected alternative

Storage-layer aggregation (combining related KN entries into thick topic
documents) was explicitly rejected in the RFC-002 interview: the decisive
test was "when one section of a thick doc proves wrong, you only want to
touch that section" — atomic entries satisfy this natively.
