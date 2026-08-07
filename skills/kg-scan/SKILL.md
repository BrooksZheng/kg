---
name: kg-scan
description: Report the health of a repository's kg harness — stale source anchors, broken references, schema and hash drift, document coverage gaps, and the always-loaded instruction surface budget. Use when a human asks how healthy the knowledge, documents, or harness are, before a release or review, or when a compile round needs to know what has rotted. Static reads only; findings are tiered so warnings do not gate.
---

# kg-scan

Measure whether the harness still matches the repository. Knowledge entries
point at document lines, carriers claim to render specific entries, proposals
target specific bytes — every one of those pointers can rot, and this skill is
what notices. It reports; it never repairs, and it never decides what a
document should say.

## Hard boundaries

- Never read `.kg/`.
- Perform static reads only by default.
- Never run builds, tests, migrations, application code, package installation,
  or network requests without explicit human authorization.
- Never follow symlinks during inventory.
- Never read secret, credential, key, certificate, database, or environment
  files.
- Never overwrite an existing human-authored document silently.
- Never set a project document to `accepted` without a direct human ruling.

## Deterministic health check

```bash
node <kg-scan>/scripts/health-check.mjs \
  --root <project-root> \
  --now <ISO-timestamp>
```

The report builder is shared by `check-staleness.mjs` and
`health-check.mjs`. It independently checks source anchors, canonical
containment, sidecar and knowledge schemas, carrier hashes, proposal target
hashes, and the KN to carrier inverse map. It never validates a sidecar by
using the sidecar's own hash as the expected byte source.

The report is version 2. Ordinary report mode emits findings and returns
success. `--gates` fails on hard errors or when the configured staleness limit
is exceeded. Legacy v1 entries with no trace on either side remain warnings.
The report also measures the configured AGENTS.md resident-surface target;
an over-budget file is a warning that points to KN-0013 and directs the next
change toward subtraction.

Findings are tiered on purpose. A repository mid-migration is full of
warnings, and a tool that refuses to run until every one is gone gets turned
off. Only hard errors gate.

Use a gate when stale sources must fail automation:

```bash
node <kg-scan>/scripts/health-check.mjs \
  --root <project-root> \
  --gates \
  --max-staleness 0
```

The command always emits a strict `kg.staleness_report`. Ordinary report mode
returns success when findings exist. Gate mode returns a nonzero status when
`staleness_count` exceeds the configured maximum.

The scanner remains static-only. It does not execute host code, follow
symlinks, or enter `.kg/`.

## Structural coverage and semantic coverage

Keep the two coverage layers separate.

Structural coverage is deterministic. `kg.staleness_report` version 2 derives
`coverage_audit` from the document taxonomy and accepted registered project
documents. `missing_core_type` means that no registered document exists for a
core taxonomy type. `uncovered_core_type` means candidates exist but fail one
or more explicit coverage conditions. These codes, counts, report bytes, and
gate behavior belong only to the deterministic builder.

Semantic coverage is agent-assisted. It asks whether a specific module or
flow has enough explanation, a runbook, or a reference for a human reader.
Record that judgment only as `semantic_coverage_gap` in a separate
`kg.scan_agent_report`. Bind it to a canonical `module_identity`, stable source
refs already present in the evidence packet, existing `coverage_evidence`, and
explicit `missing_evidence`. Never reuse `missing_core_type` or
`uncovered_core_type` for this layer.

### Agent-assisted evidence workflow

First save a completed deterministic report. Then prepare a read-only evidence
packet from the smallest source set that can support semantic review:

```bash
node <kg-scan>/scripts/health-check.mjs \
  --root <project-root> \
  --now <ISO-timestamp> \
  --output <session>/base-report.json

node <kg-scan>/scripts/prepare-agent-evidence.mjs \
  --project-root <project-root> \
  --base-report <session>/base-report.json \
  --source docs/architecture/example.md \
  --source src/modules/example/index.mjs \
  --output <session>/evidence-packet.json
```

The packet is script-produced agent input and has no `kg.*` product identity.
Its source bytes, hashes, canonical paths, line counts, and base report binding
are rechecked by the report writer.

Read the complete packet and submit strict JSON containing only `model`,
`session_id`, and `findings`. A contradiction needs at least two distinct
packet source refs and must keep `module_identity` null with empty coverage gap
fields. A semantic gap needs a canonical module identity, at least one stable
coverage ref that also appears in `source_refs`, and at least one missing
evidence key. Follow the source-ref anchor contract in
`protocol/scan-agent-report.schema.yaml`.

Write the canonical product through:

```bash
node <kg-scan>/scripts/write-agent-report.mjs \
  --project-root <project-root> \
  --base-report <session>/base-report.json \
  --evidence-packet <session>/evidence-packet.json \
  --input <session>/agent-input.json \
  --output <session>/agent-report.json \
  --now <ISO-timestamp>
```

`kg.scan_agent_report` is the only agent-layer product. Its confidence and
severity fields support human review. They never alter deterministic report
bytes, counts, verdict, or gate exit. Deterministic gate entrypoints accept no
agent report parameter and import no agent writer.

## Static repository inventory

The inventory is a read-only survey of an unfamiliar repository — manifests and
commands, module boundaries, public surfaces, terminology, existing decision
records:

```bash
node <kg-scan>/scripts/scan-inventory.mjs <repo-root> --format json

node <kg-scan>/scripts/scan-inventory.mjs <repo-root> \
  --max-files 5000 --max-bytes 512000 --max-hints 200 \
  --exclude path/to/large-area
```

The script writes nothing and executes no host code. Treat `truncated: true`
as an explicit coverage limitation, and scan one package or domain at a time
in a large monorepo.

Turning an inventory into document drafts is `kg-docs`, not this skill: follow
its brownfield bootstrap path, which preflights the whole batch, keeps every
generated document in `draft`, and proposes a patch rather than overwriting
human-authored material.

## Learning boundary

A scan reports on documents; it does not become knowledge by itself.
`kg-observe` captures reusable signals discovered during work. Record a scan
observation only when the scan process itself taught a reusable
project-specific lesson — never one observation per finding.
