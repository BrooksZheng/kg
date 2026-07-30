---
kind: kg.project_document
title: "kg architecture overview"
doc_type: architecture
status: draft
owners: [brooks]
supersedes: null
source_refs:
  - README.md
  - docs/rfc-001-project-knowledge-growth-protocol.md
  - docs/rfc-002-agents-md-compiled-artifact.md
  - docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md
  - skills/kg-init/scripts/install.mjs
  - skills/kg-scan/scripts/scan-inventory.mjs
---

# kg architecture overview

## Goals

kg grows project knowledge from two source families:

1. Complete project documents that humans and agents author directly.
2. Reusable signals observed during engineering work.

It governs extracted claims with evidence, authority, lifecycle, human
rulings, subtraction, and regret, then publishes them into carriers agents
already consume.

## Non-goals

- Vector or graph retrieval infrastructure
- A persistent service or MCP server
- Automatic acceptance of Agent inference
- Automatic execution of host code during brownfield scans
- Replacing full ADR or RFC narratives with atomic entries

## Building blocks

### Authoring Plane

`docs/` contains complete ADRs, RFCs, architecture notes, API references,
glossaries, standards, and scan reports. Registered documents opt into
`protocol/project-document.schema.yaml`. Drafting remains independent from
the observation pipeline.

### Brownfield Bootstrap

`kg-scan` performs a static deterministic inventory, then guides the Agent
through evidence-based semantic shaping. It produces draft documents and
patch proposals. It never reads `.kg/`.

### Continuous Learning

`kg-observe` appends one claim, its evidence, and scope to the observation
inbox. Human corrections use the fast-track path.

### Governed Compile

`kg-compile` reads accepted registered documents, pending observations, and
the existing knowledge ledger. It performs deduplication, collision
detection, authority comparison, routing, lifecycle changes, and reporting.

### Ledger

`knowledge/*.md` stores one governed claim per entry. Each entry carries
evidence, authority, confidence, lifecycle, scope, and regret metadata.

### Harness routing

The v2 protocol separates observation-to-knowledge compilation from
knowledge-to-harness routing. M1 defines Markdown document, skill proposal,
and script proposal carrier identities. Carrier write behavior arrives in a
later milestone.

### Protocol and shared library

`protocol/` holds nine machine interfaces. `scripts/lib/` implements the
KYAML parser, validation, protocol loading, and host path logic.

### Distribution

Every skill directory is self-contained. `scripts/sync-vendored.mjs` copies
the shared protocol and library into each skill for registry and copy
installation. Symlink installation resolves the root source directly.

## Data flow

```text
docs accepted sources ─┐
                      ├→ kg-compile → knowledge ledger → harness carriers
observations ──────────┘

existing code → kg-scan → draft docs → human review → accepted sources
```

## Trust boundaries

- `.kg/` contains uncompiled state and is isolated from normal work tasks.
- `docs/` contains collaboration artifacts and remains readable.
- Only accepted registered documents carry formal-decision authority.
- Code-derived facts use current-code authority.
- Scan interpretations remain Agent inference until confirmed.
- All collisions reach human review.

## Risks

- Skill invocation can be missed on platforms without deterministic hooks.
- Static scan hints can include test fixtures or framework-shaped false
  positives and require semantic review.
- Vendored skill copies can drift if synchronization checks are skipped.
- Registry consumers receive the default branch, so an unmerged fix is not a
  release.
- Accepted documents can drift from code and require conflict detection.
