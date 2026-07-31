---
name: kg-scan
description: Bootstrap KG project documentation from an existing brownfield codebase. Use when a human asks to scan, map, document, onboard, or understand an existing repository, or when kg-init Setup identifies a brownfield project and requests architecture, API, glossary, command, or existing-document drafts. Perform static analysis by default, preserve evidence, and keep every generated document in draft until human review.
---

# kg-scan

Create an evidence-backed starting point for an existing project. Treat the
scan as a document-authoring task. Do not turn raw scan output directly into
active KG knowledge.

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

## Workflow

### 1. Establish scope

Resolve the repository root and the requested scan areas. Default to:

- project manifests and development commands
- architecture and module boundaries
- public API, CLI, schema, and event surfaces
- domain terminology
- existing ADRs, RFCs, standards, and runbooks

Honor user exclusions. For a large monorepo, scan one package or domain at a
time.

### 2. Build the deterministic inventory

Run:

```bash
node <kg-scan>/scripts/scan-inventory.mjs <repo-root> --format json
```

Useful limits:

```bash
node <kg-scan>/scripts/scan-inventory.mjs <repo-root> \
  --max-files 5000 --max-bytes 512000 --max-hints 200 \
  --exclude path/to/large-area
```

The script writes nothing and executes no host code. Treat `truncated: true`
as an explicit coverage limitation.

### 3. Shape the evidence

Read `references/scan-playbook.md`, then inspect the smallest code set needed
to interpret inventory hints.

Classify every conclusion as:

- observed fact
- runtime fact, only after authorized execution
- inference with confidence
- conflict
- unknown

Cite file paths and line numbers. Keep current code facts separate from
architectural intent.

### 4. Author draft documents

Write a dated evidence report to:

```text
docs/inventory/SCAN-YYYYMMDD.md
```

Shape useful results into:

```text
docs/architecture/overview.md
docs/api/README.md
docs/glossary.md
```

If a target is absent, create a complete registered project document with
`status: draft`. If it already contains human-authored material, create a
patch proposal under `docs/proposals/` and point to the intended target.

Use the `protocol/project-document.schema.yaml` contract. Ordinary Markdown
remains valid and does not need KG frontmatter.

### 5. Validate and review

Run:

```bash
node .agents/skills/kg-compile/scripts/validate-project-documents.mjs
```

Report:

- coverage and scan limits
- files created
- existing files left untouched
- observed facts
- inferences and confidence
- conflicts
- narrow questions for the human

Keep documents in `draft` or `proposed`. After the human explicitly accepts a
document, update it to `status: accepted`, add `accepted_at`, validate again,
and run a separate kg-compile session.

## Learning boundary

The scan establishes a baseline through project documents. `kg-observe`
continues to capture reusable signals discovered during later work. Record a
scan observation only when the scan process itself teaches a reusable
project-specific lesson; do not duplicate every API or glossary finding into
the observation inbox.

## Deterministic staleness health check

M2 health checks inspect harness sidecar `source_refs` for path liveness only.
They do not validate line numbers, execute host code, run an agent, or enter
`.kg/`.

```bash
node <kg-scan>/scripts/health-check.mjs \
  --root <project-root> \
  --now <ISO-timestamp>
```

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
