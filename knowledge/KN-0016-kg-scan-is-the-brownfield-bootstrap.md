---
id: KN-0016
claim: "Brownfield discovery and bootstrap are bound by one set of boundaries wherever they run: static-only by default, .kg, secrets and symlinks excluded, no host code executed without explicit authorization, and drafts or patch proposals instead of silent overwrite."
category: project_contract
scope:
  paths:
    - "skills/kg-scan/**"
    - "skills/kg-docs/**"
    - "docs/inventory/**"
    - "docs/proposals/**"
evidence:
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §六 and §七 (accepted 2026-07-24)" }
  - { type: diff, ref: "skills/kg-scan/scripts/scan-inventory.mjs implements read-only traversal, budgets, exclusions, and evidence hints" }
  - { type: test, ref: "node scripts/test-rfc004.mjs proves host scripts stay unexecuted and .kg, sensitive files, sensitive directories, and symlinks stay unread" }
  - { type: observation, ref: OBS-20260806-006 }
  - { type: diff, ref: "R6.2: inventory stayed in kg-scan while bootstrap authoring moved to kg-docs; the writer rechecks eligibility against these boundaries rather than trusting the inventory's exclusion list" }
authority: formal_decision
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-08-06
regret: null
---

## Contract

The boundaries bind the activity, not one skill. Read-only discovery is
`kg-scan`'s static inventory; turning that inventory into document drafts is
`kg-docs`'s brownfield bootstrap. Both obey every rule below, and the
bootstrap writer rechecks eligibility itself rather than trusting the
inventory's exclusion list — a boundary enforced only at the reading end is
one process away from being bypassed.

The deterministic phase may inspect safe text files and report evidence
hints. It does not run builds, tests, migrations, package installation,
application code, or network requests unless the human explicitly authorizes
a separate runtime verification step.

The inventory permanently excludes `.kg/`, dependency and generated
directories, credential material, key and certificate files, databases,
oversized text, binary files, and symlinks. File and hint budgets make
truncation visible.

## Output boundary

Semantic shaping classifies evidence as observed fact, runtime fact,
inference, conflict, or unknown. Absent canonical documents may be created
with `status: draft`. Existing human-authored documents receive proposals
under `docs/proposals/` and remain untouched.
