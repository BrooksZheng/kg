---
id: KN-0010
claim: "kg is two layers with different stability commitments: the ledger layer (schemas, authority ranking, lifecycle, queue, evidence/regret chain) is the product and must stay stable; the render layer (folding, sinking, budgets, three-source assembly) is a platform-generation adapter expected to be replaced wholesale, whose patches count as normal wear, not debt."
category: project_contract
scope:
  paths: ["protocol/**", docs/rfc-002-agents-md-compiled-artifact.md]
evidence:
  - { type: observation, ref: OBS-20260713-015 }
  - { type: quote, ref: "human: 可以，写进 RFC-002 — after asking for and receiving a plain-language re-alignment of the doctrine" }
  - { type: quote, ref: "docs/rfc-002-agents-md-compiled-artifact.md §二 two-layer doctrine (confirmed 2026-07-13)" }
authority: formal_decision
confidence: 0.9
lifecycle: candidate
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Contract

kg's constitutional self-positioning (RFC-002 §二):

- **Ledger layer** — observation/knowledge schemas, authority ranking,
  lifecycle state machine, ruling queue, evidence/regret chain, subtraction
  discipline. This is the product. Its value is information-theoretic
  (intent, rejected alternatives, and ruling rationale are permanently lost
  if unrecorded) and INDEPENDENT of agent intelligence level.
- **Render layer** — folding, sinking, pointer lines, tiered budgets,
  three-source assembly, anchor management. This is a consumable adapter
  serving current-generation model limits (finite context, attention
  dilution, no persistent memory). Platform-native memory maturing is
  expected to obsolete most of it — normal depreciation, not design failure.

**Patch policy / alarm condition**: render-layer patches are normal wear and
never count as debt. Recurring patches to the LEDGER layer (schema, authority,
lifecycle, queue semantics changing repeatedly) are the true failure signal
for kg's core thesis.

**Honest exit conditions** (re-evaluate kg's existence if reached): the
platform natively ships governed, human-reviewed, git-auditable memory; or
the host project is short-lived / low decision density / single-human intent
supply — then a hand-written AGENTS.md is the correct answer and kg is
over-engineering.

## Where the other RFC-002 rulings live

R1–R10 rulings and their rejected alternatives are recorded in
`docs/rfc-002-agents-md-compiled-artifact.md` (§一, §七). The
implementation-pending ones (required domains, rescope action, tiered
rendering/budgets, pointer lines, domain vocabulary review, three-source
prose assembly) are deliberately NOT duplicated as knowledge entries: the S1–S3
implementation slices will carry them into machine carriers (schema, routing,
renderer), and copying them into entries now would create a second source of
truth — the exact pattern R8 rejected.
