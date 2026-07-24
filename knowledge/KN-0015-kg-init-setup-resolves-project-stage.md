---
id: KN-0015
claim: "kg-init Setup resolves project stage (greenfield or brownfield) and document profile (none, lean, or standard), creates only missing template files, and routes brownfield hosts to a separate kg-scan session."
category: project_contract
scope:
  paths: ["skills/kg-init/**", docs/README.md]
evidence:
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §五 (accepted 2026-07-24)" }
  - { type: diff, ref: "skills/kg-init/scripts/install.mjs implements --project-stage and --docs-profile with create-if-missing templates" }
  - { type: test, ref: "node scripts/test-rfc004.mjs covers lean, standard, none, preservation, copy, vendored rerun, symlink, and Claude wiring" }
authority: formal_decision
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-23
regret: null
---

## Contract

The manual Setup interview asks for two choices only when the user has not
already supplied them:

1. `greenfield` or `brownfield`
2. `none`, `lean`, or `standard`

The selected profile is passed explicitly to
`skills/kg-init/scripts/install.mjs`. Direct script calls retain the `none`
default so existing upgrades do not gain files unexpectedly.

## Preservation boundary

Profile installation creates a template only when its destination does not
exist. Existing documents remain unchanged on the first run and every rerun.
For a brownfield host, the installer finishes deterministic setup and points
the Agent to `skills/kg-scan/SKILL.md` for semantic discovery.

The exact profile contents live in the installer and its assets. Treat those
paths as the live interface.
