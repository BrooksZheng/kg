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

The installer consumes `kg.migration_detection` version 2 before mutation.
Greenfield and non-KG hosts receive the v2 pipeline, skill wiring, profile
directories, and only `docs/README.md` as document content. Existing project
documents and human AGENTS bytes are preserved. V1, v2, and partial hosts are
routed to Phase 0, verify, or repair and human handling respectively.

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
node skills/kg-observe/scripts/add-observation.mjs <draft.json>
node skills/kg-observe/scripts/add-observation.mjs --stdin
node skills/kg-observe/scripts/validate-observations.mjs
node skills/kg-observe/scripts/check-threshold.mjs
```

Agent drafts are strict JSON. The writer generates `id` and `at`, rejects
agent-submitted `compiled_to_kn`, and stores canonical KYAML.

## Brownfield architecture bootstrap

```bash
node skills/kg-docs/scripts/inventory.mjs \
  --root <project-root> --output <inventory.json>
node skills/kg-docs/scripts/bootstrap.mjs \
  --project-root <project-root> \
  --inventory <inventory.json> \
  --plan <bootstrap-plan.json>
```

The inventory is static-only. The plan is strict JSON. R2.1 creates only a
missing `docs/architecture/overview.md`.

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
node skills/kg-compile/scripts/archive-observations.mjs \
  --observation <OBS-id> --compiled-to-kn <KN-id>
node skills/kg-compile/scripts/archive-observations.mjs \
  --observation <OBS-id> --verdict <routing-verdict>
node skills/kg-compile/scripts/report-metrics.mjs [--clear-round]
```

Exactly one archive result is required. KN-producing routes use
`--compiled-to-kn`; legal no-KN outcomes from `protocol/routing.yaml` use
`--verdict`. The workflow and legal sequencing live in
`skills/kg-compile/SKILL.md`.

## Shared module exports

`scripts/lib/protocol.mjs` exports all nine protocol loaders, schema
validation, frontmatter parsing, and rendering helpers. `scripts/lib/host.mjs`
exports host-root discovery, paths, config loading, ID allocation, and
compile-round action logging.
