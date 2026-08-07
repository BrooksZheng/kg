# Brownfield scan playbook

Use this reference after the deterministic inventory has identified the
project languages, manifests, code paths, and existing documents.

## Evidence classes

| Class | Meaning | Required treatment |
| --- | --- | --- |
| observed fact | Directly visible in current code or schema | Cite file and line |
| runtime fact | Reproduced by an explicitly authorized command | Cite command and output |
| inference | Agent interpretation of responsibility, terminology or boundary | Cite evidence and confidence |
| conflict | Two sources disagree | Preserve both and request a ruling |
| unknown | Evidence is missing or ambiguous | Turn into a narrow interview question |

## Scan order

1. Read manifests and tool configuration.
2. Identify build, test and development commands.
3. Map top-level modules and package boundaries.
4. Trace public API routes, CLI commands, schemas and events.
5. Read domain types and repeated business identifiers for glossary candidates.
6. Inventory existing ADRs, RFCs, standards and runbooks.
7. Compare accepted docs with current code and list conflicts.
8. Draft documents with provenance.

## Language probes

Use `rg` first, then read only the files needed to interpret a match.

### JavaScript and TypeScript

- Public surface: `export`, package `exports`, barrel files
- HTTP: router registration, framework route files, OpenAPI
- Schema: Zod, GraphQL, JSON Schema, ORM models
- Commands: `package.json` scripts and CLI entrypoints

### Python

- Public surface: package `__init__.py`, `__all__`
- HTTP: framework router decorators and URL configuration
- Schema: Pydantic, dataclasses, serializers, ORM models
- Commands: console scripts, Click, Typer, argparse

### Go

- Public surface: exported identifiers and package docs
- HTTP: `Handle`, `HandleFunc`, router registration
- Schema: structs used at boundaries, protobuf
- Commands: `cmd/*`, Cobra registrations

### Java and Kotlin

- Public surface: public interfaces and exported packages
- HTTP: controller and mapping annotations
- Schema: DTOs, records, serialization annotations
- Commands: Gradle or Maven tasks and application entrypoints

### Ruby

- Public surface: gems, modules and service entrypoints
- HTTP: Rails routes and controller actions
- Schema: migrations, models and serializers
- Commands: Rake tasks and executable scripts

## Output rules

- Create absent canonical documents with `status: draft`.
- When a canonical document already contains human-authored material, write a
  proposal under `docs/proposals/` and identify the intended target.
- Write a dated inventory report under `docs/inventory/`.
- Keep API facts, architecture interpretations and glossary candidates in
  separate sections.
- Mark scan limits and truncation.
- Never set `status: accepted` without a direct human ruling.
- Never convert every scan finding into an observation. Project documents are
  the scan deliverable; Observer remains the continuous-learning path.
