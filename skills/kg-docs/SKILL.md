---
name: kg-docs
description: Build and maintain evidence-backed project documents. Use as a supporting skill during project work, and use its bootstrap path when a brownfield repository needs initial core-document drafts.
---

# kg-docs

Create project documents from validated evidence. This skill is a supporting
mechanism for kickoff and ordinary work sessions. It does not replace human
review or project-document lifecycle decisions.

## R3.3 brownfield bootstrap

Bootstrap creates one draft for every core document type declared by
`protocol/document-taxonomy.yaml`. The taxonomy owns routing and each
`assets/templates/*.md` file owns that type's required section keys. Read both
before preparing a plan. Existing targets require the R3.4 proposal workflow.

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
`{slug}`. Keep `slug` null for fixed targets. Keep `target_path` null in create
mode. The renderer derives paths and allocates any `{sequence}` value with an
exclusive create.

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
evidence range before writing. It preflights the full batch, then creates all
registered `draft` documents. Every rendered finding carries a machine-readable
evidence marker. Any target, source, schema, template, or route failure leaves
the batch with zero documents.

### Version 1 compatibility

The M2 architecture-only version 1 plan remains accepted. It continues to
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
