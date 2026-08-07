---
name: kg-docs
description: Build and maintain evidence-backed project documents. Use as a supporting skill during project work, and use its bootstrap path when a brownfield repository needs initial core-document drafts.
---

# kg-docs

Create project documents from validated evidence. This skill is a supporting
mechanism for kickoff and ordinary work sessions. It does not replace human
review or project-document lifecycle decisions.

## Lazy single-target scaffold

Use scaffold when one conversation has crystallized one project document.
Routes come from `protocol/document-taxonomy.yaml`. Section keys and ADR
semantic roles come from the selected template markers. One invocation handles
one explicit document type and writes no other taxonomy target.

Every scaffold requires a transcript envelope with a structured approval:

```json
{
  "transcript": [
    {"role": "user", "content": "Approve one API draft."}
  ],
  "approvals": [
    {"message_index": 0, "action": "scaffold:api"}
  ]
}
```

Submit strict JSON containing the requested type, a taxonomy-safe slug when
the route requires one, actual section content, stable source refs, and the
approval pointer. Keep `candidate_ref` and `adr_assessment` null for every
type except decision.

```json
{
  "doc_type": "api",
  "slug": "orders",
  "title": "Orders API",
  "candidate_ref": null,
  "source_refs": ["docs/architecture/overview.md#L12"],
  "sections": [
    {
      "key": "surface",
      "content": ["POST /orders retries with the original idempotency key."]
    }
  ],
  "adr_assessment": null,
  "human_approval_message_index": 0
}
```

A real request contains every section marker from the selected template.
Run:

```bash
node <skill>/scripts/scaffold.mjs \
  --project-root <project-root> \
  --input <artifacts>/scaffold-input.json \
  --transcript <artifacts>/transcript.json \
  --output <artifacts>/scaffold-result.json
```

Missing targets become registered `draft` documents. Existing targets retain
their original bytes and produce a content-addressed
`docs/proposals/scaffold-<content-id>/` bundle. The result product records the
target, mode, candidate hash, approval pointer, and assessment ref.

### Decision assessment

Read `references/adr-criteria.md`. The evidence packet is strict JSON with one
record per candidate and the source refs available to assess it. Submit all
three criterion IDs from `protocol/adr-assessment.schema.yaml`, each with a
boolean conclusion, confidence from 0 through 1, and at least one packet ref.

```bash
node <skill>/scripts/assess-adr.mjs \
  --evidence-packet <artifacts>/adr-evidence-packet.json \
  --transcript <artifacts>/transcript.json \
  --input <artifacts>/adr-assessment-input.json \
  --output <artifacts>/adr-assessment.json
```

The transcript approval action is `draft:<candidate_ref>`. The writer computes
`eligible_for_draft` from all three conclusions plus that structured approval.
An ineligible assessment may be recorded, and scaffold will reject it before
any target write.

Decision section content follows template roles. The alternatives role uses at
least two objects with exact `option` and `tradeoff` fields. The consequences
role uses at least one non-empty string. Other decision sections use non-empty
string lists. The request includes the matching `candidate_ref`, assessment
path, and `scaffold:decision` approval.

## Brownfield bootstrap

Bootstrap creates one draft for every core document type declared by
`protocol/document-taxonomy.yaml`. The taxonomy owns routing and each
`assets/templates/*.md` file owns that type's required section keys. Read both
before preparing a plan. Missing targets use direct draft creation. Existing
targets use content-addressed proposal bundles and remain byte-for-byte intact.

### 1. Produce the static inventory

Run the inventory script. Keep its output outside the project tree.

```bash
node <skill>/scripts/inventory.mjs \
  --root <project-root> \
  --output <artifacts-dir>/repository-inventory.json
```

The inventory is static-only. It excludes `.kg` in any letter case, secrets,
binaries, oversized files, dependency or generated directories, and
symbolic links. It never executes host code.

### 2. Inspect bounded evidence

Read the inventory first. Then read only the safe files needed to understand
the manifest, source modules, entrypoint, external boundaries, runtime flow,
and deployment signals. Use inventory file paths and valid one-based line
ranges.

### 3. Submit a strict version 2 JSON plan

Write `bootstrap-plan.json` with this raw agent shape. Include every taxonomy
core type exactly once and order them as `core_types` does. The example shows
one document and one section only to explain nesting; a real plan contains all
documents and all template sections.

```json
{
  "kind": "kg.docs_bootstrap_plan",
  "version": 2,
  "documents": [
    {
      "doc_type": "architecture",
      "slug": null,
      "title": "Example architecture overview",
      "mode": "create",
      "target_path": null,
      "coverage_limitations": [],
      "sections": [
        {
          "key": "context",
          "findings": [
            {
              "classification": "observed_fact",
              "statement": "The service exposes an HTTP entrypoint.",
              "sources": [
                {
                  "path": "src/server.mjs",
                  "line_start": 4,
                  "line_end": 4
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Use a lowercase safe slug only when the taxonomy target pattern contains
`{slug}`. Keep `slug` null for fixed targets. In `create` mode, keep
`target_path` null. In `proposal` mode, set `target_path` to the exact existing
project-relative taxonomy target and keep the matching slug. The renderer
derives create paths and allocates any `{sequence}` value with an exclusive
create.

Each template section needs at least one finding. Classification rules are:

- `observed_fact` has at least one inventoried source.
- `inference` has a numeric `confidence` from 0 through 1 and at least one
  inventoried source.
- `conflict` has at least two distinct inventoried sources.
- `unknown` has an empty `sources` list and a non-empty `missing_evidence`.

If the inventory is truncated, every document must carry a non-empty
`coverage_limitations` list. The renderer preserves it in machine-readable
frontmatter and evidence metadata.

Do not submit IDs, timestamps, hashes, sequence numbers, lifecycle fields, or
derived output paths. The script rebuilds the canonical plan and owns that
metadata.

### 4. Render through the bootstrap script

```bash
node <skill>/scripts/bootstrap.mjs \
  --project-root <project-root> \
  --inventory <artifacts-dir>/repository-inventory.json \
  --plan <artifacts-dir>/bootstrap-plan.json
```

The script revalidates every inventory file hash, exclusion boundary, and
evidence range before writing. It preflights the full batch, then creates
registered `draft` documents for missing targets. For each existing target it
writes `docs/proposals/bootstrap-<content-id>/manifest.json` and `candidate.md`.
The manifest binds the target, candidate, inventory, document type, and source
references. Identical input reuses the same bundle. Target drift after inventory
invalidates the plan. Every rendered finding carries a machine-readable
evidence marker. Any target, source, schema, template, or route failure leaves
the batch with zero new output.

### Version 1 compatibility

The architecture-only version 1 plan remains accepted. It continues to
create only `docs/architecture/overview.md` with its original four sections.
New brownfield sessions use version 2.

## Hard boundaries

- Never read `.kg/`.
- Never execute host code, builds, tests, migrations, package installation,
  or network requests during bootstrap.
- Never follow symbolic links.
- Never put secrets, binary content, or oversized files into an inventory or
  plan.
- Never write project-document status `accepted`. Human review controls that
  lifecycle transition.
- Never bypass `bootstrap.mjs` by writing project-document Markdown directly.
- Never use `create` for an existing target or hand-write a proposal bundle.
- Never scaffold more than the one explicitly requested taxonomy type.
- Never scaffold a decision from missing, ineligible, or candidate-mismatched ADR assessment.
