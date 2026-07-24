# kg project documents

Project stage: `brownfield`

This directory is the direct authoring plane for kg. Humans and agents may
draft and revise complete RFCs, ADRs, architecture documents, technical plans,
and standards here without first creating an observation.

## Lifecycle

Files that opt into KG source governance declare
`kind: kg.project_document`.

- `draft`: active writing and exploration
- `proposed`: ready for human review
- `accepted`: approved source for Compile
- `rejected`: declined proposal retained for history
- `superseded`: historical source replaced by another document

Only a direct human ruling can move a document to `accepted`. Ordinary
Markdown remains valid and is ignored by the project-document validator.
Superseded documents retain their original `accepted_at` and add a
`superseded_by` pointer.

## Document map

| Area | Location | Status |
| --- | --- | --- |
| Architecture | `architecture/overview.md` | draft |
| Script and protocol API | `api/README.md` | draft |
| Glossary | `glossary.md` | draft |
| Brownfield inventory | `inventory/SCAN-20260724.md` | draft |
| Founding protocol | `rfc-001-project-knowledge-growth-protocol.md` | confirmed legacy source |
| Render architecture | `rfc-002-agents-md-compiled-artifact.md` | confirmed legacy source |
| Authoring and scan | `rfc-004-authoring-plane-and-brownfield-bootstrap.md` | accepted registered source |

## Validation

```bash
node skills/kg-compile/scripts/validate-project-documents.mjs
```

Compile reads accepted registered documents together with pending observations
and existing knowledge entries. KN entries keep atomic claims and point back
to source sections.
