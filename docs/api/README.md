---
kind: kg.project_document
title: "kg script and protocol API"
doc_type: api
status: draft
owners: [brooks]
supersedes: null
source_refs:
  - skills/kg-init/scripts/install.mjs
  - skills/kg-init/scripts/migrate-v1.mjs
  - skills/kg-kickoff/scripts/gather-context.mjs
  - skills/kg-spec/scripts/produce-spec.mjs
  - skills/kg-scan/scripts/scan-inventory.mjs
  - skills/kg-scan/scripts/health-check.mjs
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

## Migration

```bash
node skills/kg-init/scripts/detect-migration.mjs --root <host-root>
node skills/kg-init/scripts/migrate-v1.mjs \
  --root <host-root> --output <plan.json> [--skills-source <skills-dir>]
node skills/kg-init/scripts/migrate-v1.mjs --root <host-root> --execute [--plan <plan.json>]
node skills/kg-init/scripts/migrate-v1.mjs --root <host-root> --resolve <resolution.json>
node skills/kg-init/scripts/migrate-v1.mjs --root <host-root> --rollback
```

Detection emits `kg.migration_detection` version 2 and classifies the host as
non-KG, v1, v2, partial, or unknown. Phase 0 writes a plan outside the host and
seals it; phase 1 executes it and is re-entrant after an interruption at any
checkpoint. Queue items that cannot be converted are quarantined for a human
ruling through `--resolve`, and `--rollback` restores the recorded backups.

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

## Task kickoff

```bash
node skills/kg-kickoff/scripts/gather-context.mjs \
  --root <project-root> --task "<task bytes>" \
  --phase index --output <artifacts>/kickoff-index.json
node skills/kg-kickoff/scripts/write-scope.mjs \
  --project-root <project-root> --index <index.json> \
  --transcript <transcript.json> --input <scope-input.json> \
  --output <artifacts>/kickoff-scope.json
node skills/kg-kickoff/scripts/gather-context.mjs \
  --root <project-root> --phase deep \
  --index <index.json> --scope <scope.json> \
  --output <artifacts>/kickoff-context.json
node skills/kg-kickoff/scripts/record-session.mjs --start|--advance ...
node skills/kg-kickoff/scripts/record-turn.mjs ... --output <turn-001.json>
node skills/kg-kickoff/scripts/record-conflicts.mjs ... --output <conflicts-001.json>
```

Retrieval is two-phase: the index carries metadata for every declared source
and no body text, and deep mode accepts the scope product as its only
read-set authority. Machine products stay outside the host `.kg` directory.
Recording a turn requires an explicit product version; the writers assign all
identities and bind message bytes by hash.

## Spec synthesis

```bash
node skills/kg-spec/scripts/produce-spec.mjs --prepare \
  --project-root <project-root> --transcript <kickoff-transcript.json> \
  [--kickoff-artifacts <root>] --output <spec-packet.json>
node skills/kg-spec/scripts/produce-spec.mjs --validate-synthesis \
  --project-root <project-root> --packet <spec-packet.json> \
  --synthesis <draft.json>
node skills/kg-spec/scripts/produce-spec.mjs --archive \
  --project-root <project-root> --packet <spec-packet.json> \
  --synthesis <validated.json>
```

Archive writes only `docs/specs/TASK-YYYYMMDD-NNN.md`, starts the document at
`draft`, and never overwrites an existing file.

## Harness health

```bash
node skills/kg-scan/scripts/health-check.mjs --root <project-root> \
  [--now <ISO>] [--output <report.json>] [--gates] [--max-staleness N]
node skills/kg-scan/scripts/prepare-agent-evidence.mjs \
  --project-root <project-root> --base-report <report.json> \
  --source <path>... --output <evidence-packet.json>
node skills/kg-scan/scripts/write-agent-report.mjs \
  --project-root <project-root> --base-report <report.json> \
  --evidence-packet <packet.json> --input <agent-input.json> \
  --output <agent-report.json> --now <ISO>
```

The deterministic report is `kg.staleness_report` version 2. Ordinary report
mode returns success; `--gates` fails on hard errors or when staleness exceeds
the configured maximum. The agent layer produces a separate
`kg.scan_agent_report` that never alters deterministic report bytes, counts,
verdict, or gate exit, and its outputs must resolve outside the project root.

## Observation intake

```bash
node skills/kg-observe/scripts/add-observation.mjs <draft.json>
node skills/kg-observe/scripts/add-observation.mjs --stdin
node skills/kg-observe/scripts/validate-observations.mjs
node skills/kg-observe/scripts/check-threshold.mjs
```

Agent drafts are strict JSON. The writer generates `id` and `at`, rejects
agent-submitted `compiled_to_kn`, and stores canonical KYAML.

## Brownfield project-document bootstrap

```bash
node skills/kg-docs/scripts/inventory.mjs \
  --root <project-root> --output <inventory.json>
node skills/kg-docs/scripts/bootstrap.mjs \
  --project-root <project-root> \
  --inventory <inventory.json> \
  --plan <bootstrap-plan.json>
```

The inventory is static-only. The plan is strict JSON. Version 2 routes and
creates all taxonomy core types as one atomic draft batch. Required section
keys come from `skills/kg-docs/assets/templates/`. Version 1 remains readable
for saved architecture-only plans.

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

`scripts/lib/protocol.mjs` exports a loader for every protocol file, schema
validation, frontmatter parsing, and rendering helpers. `scripts/lib/host.mjs`
exports host-root discovery, paths, config loading, ID allocation, and
compile-round action logging.
