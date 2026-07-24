---
id: KN-0017
claim: "kg-compile consumes only registered project documents with status accepted; ordinary Markdown and draft, proposed, rejected, or superseded registered documents remain outside compilation."
category: project_contract
scope:
  paths:
    - "docs/**"
    - protocol/project-document.schema.yaml
    - skills/kg-compile/scripts/validate-project-documents.mjs
    - skills/kg-compile/SKILL.md
evidence:
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §四 and §八 (accepted 2026-07-24)" }
  - { type: diff, ref: "protocol/project-document.schema.yaml and validate-project-documents.mjs implement opt-in lifecycle validation and accepted-source listing" }
  - { type: test, ref: "node scripts/test-rfc004.mjs validates accepted input, ignored ordinary Markdown, missing accepted_at rejection, and superseded history" }
authority: formal_decision
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-23
regret: null
---

## Contract

Markdown opts into compilation only by declaring
`kind: kg.project_document` and passing
`protocol/project-document.schema.yaml`. The validator checks lifecycle
metadata and exposes accepted sources through `--list-accepted`.

Only `accepted` documents are compiler inputs. Ordinary Markdown and
registered documents in every other state remain normal project artifacts
and carry no formal decision authority in Compile.

## Lifecycle

Agents may create and revise drafts directly. A direct human ruling is
required before setting `status: accepted` and `accepted_at`. Superseded
documents retain their original acceptance date and point to their
replacement through `superseded_by`.
