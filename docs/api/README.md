---
kind: kg.project_document
title: "kg script and protocol API"
doc_type: api
status: draft
owners: [brooks]
supersedes: null
source_refs:
  - skills/kg-init/scripts/install.mjs
  - skills/kg-scan/scripts/scan-inventory.mjs
  - skills/kg-observe/scripts/add-observation.mjs
  - skills/kg-compile/scripts/validate-project-documents.mjs
  - scripts/lib/protocol.mjs
---

# kg script and protocol API

kg exposes file and command interfaces. It has no HTTP service.

## Setup

```bash
node skills/kg-init/scripts/install.mjs [host-root] [--copy] \
  [--threshold N] \
  [--docs-profile none|lean|standard] \
  [--project-stage greenfield|brownfield]
```

The installer creates missing pipeline and document files, ensures an
`AGENTS.md` file exists without generating its content, and wires the current
installable skills. Existing project documents are preserved.

## Brownfield inventory

```bash
node skills/kg-scan/scripts/scan-inventory.mjs [root] \
  [--format json|markdown] \
  [--max-files N] [--max-bytes N] [--max-hints N] \
  [--exclude relative/path]...
```

The command is read-only and static. JSON output has
`kind: kg.scan_inventory` and reports limits, truncation, languages,
manifests, commands, documents, API hints, public symbols, schemas, terms, and
safety exclusions.

## Observation intake

```bash
node skills/kg-observe/scripts/add-observation.mjs <draft.yaml>
node skills/kg-observe/scripts/add-observation.mjs --stdin
node skills/kg-observe/scripts/validate-observations.mjs
node skills/kg-observe/scripts/check-threshold.mjs
```

## Project-document sources

```bash
node skills/kg-compile/scripts/validate-project-documents.mjs
node skills/kg-compile/scripts/validate-project-documents.mjs --list-accepted
```

Ordinary Markdown is ignored. Registered documents conform to
`protocol/project-document.schema.yaml`.

## Knowledge compilation

```bash
node skills/kg-compile/scripts/add-entry.mjs <draft.md>
node skills/kg-compile/scripts/add-queue-item.mjs <draft.yaml>
node skills/kg-compile/scripts/validate-knowledge.mjs
node skills/kg-compile/scripts/transition-entry.mjs ...
node skills/kg-compile/scripts/archive-observations.mjs ...
node skills/kg-compile/scripts/report-metrics.mjs [--clear-round]
```

The workflow and legal sequencing live in `skills/kg-compile/SKILL.md`.

## Shared module exports

`scripts/lib/protocol.mjs` exports all nine protocol loaders, schema
validation, frontmatter parsing, and rendering helpers. `scripts/lib/host.mjs`
exports host-root discovery, paths, config loading, ID allocation, and
compile-round action logging.
