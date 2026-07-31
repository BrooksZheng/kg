---
name: kg-docs
description: Build and maintain evidence-backed project documents. Use as a supporting skill during project work, and use its bootstrap path when a brownfield repository needs an initial architecture draft.
---

# kg-docs

Create project documents from validated evidence. This skill is a supporting
mechanism for kickoff and ordinary work sessions. It does not replace human
review or project-document lifecycle decisions.

## R2.1 brownfield bootstrap

The first bootstrap path creates only a missing
`docs/architecture/overview.md`. Existing targets require the later proposal
workflow.

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

### 3. Submit a strict JSON plan

Write `bootstrap-plan.json` with this shape:

```json
{
  "kind": "kg.docs_bootstrap_plan",
  "version": 1,
  "title": "Example architecture overview",
  "coverage_limitations": [],
  "observed_facts": [
    {
      "section": "context",
      "statement": "The service exposes an HTTP entrypoint.",
      "source": {
        "path": "src/server.mjs",
        "line_start": 4,
        "line_end": 4
      }
    }
  ],
  "inferences": [
    {
      "section": "deployment",
      "statement": "The process is likely deployed as one service.",
      "confidence": 0.7,
      "sources": [
        {
          "path": "package.json",
          "line_start": 5,
          "line_end": 5
        }
      ]
    }
  ]
}
```

Valid sections are `context`, `building_blocks`, `runtime`, and `deployment`.
Every observed fact needs one source. Every inference needs confidence and at
least one source. If the inventory is truncated, `coverage_limitations` must
describe the missing coverage.

Do not submit IDs, timestamps, hashes, lifecycle fields, or output paths.
The script owns deterministic metadata and the fixed target path.

### 4. Render through the bootstrap script

```bash
node <skill>/scripts/bootstrap.mjs \
  --project-root <project-root> \
  --inventory <artifacts-dir>/repository-inventory.json \
  --plan <artifacts-dir>/bootstrap-plan.json
```

The script revalidates every inventory file hash and evidence range before
writing. It creates a registered `draft` architecture document and refuses
an existing target.

## Hard boundaries

- Never read `.kg/`.
- Never execute host code, builds, tests, migrations, package installation,
  or network requests during bootstrap.
- Never follow symbolic links.
- Never put secrets, binary content, or oversized files into an inventory or
  plan.
- Never write project-document status `accepted`. Human review controls that
  lifecycle transition.
- Never bypass `bootstrap.mjs` by writing the architecture Markdown directly.
