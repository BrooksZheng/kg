# {{PROJECT_NAME}} project documents

Project stage: `{{PROJECT_STAGE}}`

This directory is the direct authoring plane for project documentation.
Humans and agents may draft and revise complete ADRs, RFCs, architecture
notes, technical plans, and standards here without first creating a KG
observation.

## Document lifecycle

Registered KG source documents use `kind: kg.project_document` frontmatter.

- `draft`: active writing and exploration
- `proposed`: ready for human review
- `accepted`: approved source for KG Compile
- `rejected`: retained proposal that was declined
- `superseded`: historical source replaced by a newer document

Only a human can authorize changing a document to `accepted`. Ordinary
Markdown without KG frontmatter remains valid project documentation and is
ignored by Compile.
Superseded documents retain their original `accepted_at` and add a
`superseded_by` pointer.

## Current document map

| Area | Location | Purpose |
| --- | --- | --- |
| Architecture | `architecture/overview.md` | System context, boundaries, runtime and deployment |
| Decisions | `decisions/` | One accepted architectural decision per record |
| Proposals | `rfcs/` | Complete designs under discussion |
| Glossary | `glossary.md` | Project and domain terminology |
| Standards | `standards/` | Project-specific conventions and rationale |
| Development | `development.md` | Build, test and contribution workflow |
| API | `api/` | Public interfaces discovered or documented by the project |
| Inventory | `inventory/` | Evidence-backed brownfield scan reports |
| Scan proposals | `proposals/` | Suggested patches when a scan finds existing docs |

## Compilation

Validate registered documents:

```bash
node .agents/skills/kg-compile/scripts/validate-project-documents.mjs
```

Compile reads accepted registered documents together with pending observations
and existing knowledge entries. Atomic KN entries should point back to the
source document instead of copying its full narrative.
