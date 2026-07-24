---
id: KN-0016
claim: "kg-scan is the brownfield bootstrap adapter: it is static-only by default, excludes .kg, secrets, and symlinks, executes no host code without explicit authorization, and produces drafts or patch proposals without silent overwrite."
category: project_contract
scope:
  paths:
    - "skills/kg-scan/**"
    - "docs/inventory/**"
    - "docs/proposals/**"
evidence:
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §六 and §七 (accepted 2026-07-24)" }
  - { type: diff, ref: "skills/kg-scan/scripts/scan-inventory.mjs implements read-only traversal, budgets, exclusions, and evidence hints" }
  - { type: test, ref: "node scripts/test-rfc004.mjs proves host scripts stay unexecuted and .kg, sensitive files, sensitive directories, and symlinks stay unread" }
authority: formal_decision
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-23
regret: null
---

## Contract

Brownfield discovery runs through the separate `kg-scan` Skill. Its
deterministic phase may inspect safe text files and report evidence hints. It
does not run builds, tests, migrations, package installation, application
code, or network requests unless the human explicitly authorizes a separate
runtime verification step.

The inventory permanently excludes `.kg/`, dependency and generated
directories, credential material, key and certificate files, databases,
oversized text, binary files, and symlinks. File and hint budgets make
truncation visible.

## Output boundary

Semantic shaping classifies evidence as observed fact, runtime fact,
inference, conflict, or unknown. Absent canonical documents may be created
with `status: draft`. Existing human-authored documents receive proposals
under `docs/proposals/` and remain untouched.
