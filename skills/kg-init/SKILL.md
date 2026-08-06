---
name: kg-init
description: "Install and set up the kg (Project Knowledge Growth) pipeline and optional project-document profiles in a host repository. MANUAL INVOCATION ONLY: run this skill exclusively when a human explicitly asks to set up, install, initialize, configure, or repair kg, knowledge growth, a project documentation baseline, or the brownfield bootstrap flow. Never auto-trigger it from inferred context; report a broken or missing install and wait for explicit human approval. The installer is idempotent and preserves existing project documents."
disable-model-invocation: true
---

# kg-init

Installing kg ensures an `AGENTS.md` file exists, updates ignore files and
skill wiring, and can add an optional document baseline. Require an explicit
human request.

## Setup interview

Before a first install, resolve two choices. Ask only when the user has not
already provided the answer:

1. Project stage: `greenfield` or `brownfield`.
2. Document profile: `lean`, `standard`, or `none`.

Recommend `standard` for a normal long-lived project. Recommend `lean` for a
small or short-lived project. Use `none` when the host already has a deliberate
documentation system and only needs KG wiring.

For brownfield, finish installation first, then continue with the `kg-docs`
bootstrap flow. Repository interpretation stays outside the deterministic
installer.

## Healthy v1 migration

Migration accepts one shape: a healthy v1 host. Detect it first:

```bash
node <plugin>/skills/kg-init/scripts/detect-migration.mjs --root <host-root>
```

Continue only when the JSON classification is `v1`. Generate a machine plan
outside the host, review its operations and preservation strategies, then
execute that exact plan:

```bash
node <plugin>/skills/kg-init/scripts/migrate-v1.mjs \
  --root <host-root> --skills-source <plugin>/skills \
  --output <outside-host>/migration-plan.json

node <plugin>/skills/kg-init/scripts/migrate-v1.mjs \
  --root <host-root> --execute --plan <outside-host>/migration-plan.json
```

`--skills-source` defaults to the `skills/` directory of the repository
containing the migration script.  When running from a host-installed location
(`.agents/skills/kg-init/scripts/migrate-v1.mjs`), the default resolves inside
the host and triggers a canonical collision — pass `--skills-source` pointing
to the kg plugin repository's `skills/` directory instead.

The executor never derives actions from prose. It verifies the canonical host
and skill-source identities, input hashes, queue compatibility, managed
markers, and all planned outputs before mutation. Preserve the plan file after
generation — it is required for recovery and for the executor's identity
checks.

If the process is interrupted, the recovery path depends on how far migration
progressed:

- **Interrupted during skill replacement** (config and AGENTS.md are still v1):
  run `detect-migration.mjs --root <host-root>`.  If the classification is
  `v1`, you can re-generate a fresh plan and execute it.

- **Interrupted after skill replacement** (config and AGENTS.md are now v2):
  re-run `--execute` with the **same** plan file.  Do NOT regenerate a new
  plan on a partially-migrated host — the host is no longer classified as v1
  and plan generation will refuse.  If you lose the plan in this state, the
  host requires manual repair.

## Install

```bash
node <plugin>/skills/kg-init/scripts/install.mjs [host-root] [--copy] \
  [--threshold N] \
  [--docs-profile none|lean|standard] \
  [--project-stage greenfield|brownfield]
```

When registry installation already placed the skills under `.agents/skills/`,
run:

```bash
node .agents/skills/kg-init/scripts/install.mjs \
  --docs-profile standard --project-stage brownfield
```

`host-root` defaults to `$KG_ROOT` or the current directory. A direct script
call defaults to `--docs-profile none` for upgrade compatibility. The Setup
interview should pass the selected profile explicitly. `--project-stage` is a
compatibility hint only. Detection owns the host classification.

The installer runs the read-only version 2 detector before mutation. A
greenfield or non-KG host receives the v2 pipeline, the selected directory
skeleton, and only `docs/README.md` as document content. Existing docs and
human AGENTS bytes are preserved while missing v2 entry sections are added.
A v1 host routes to migration Phase 0, a healthy v2 host is verified, and a
partial host reports the required repair or human action. Reruns are
idempotent.

## Installed layout

```text
.kg/                       pipeline state; working agents MUST NOT read this
  config.yaml
  observations/
  observations/processed/
  queue/
  reports/
knowledge/                 atomic compiled knowledge
docs/                      direct-authoring project documents when selected
  README.md                document map and lifecycle contract
  architecture/
  decisions/
  rfcs/                    standard profile
  standards/               standard profile
AGENTS.md                  preserved human instructions plus v2 entry sections
.cursorignore
.agents/skills/kg-*
.claude/skills/kg-*        Claude-marker hosts only
CLAUDE.md                  Claude-marker hosts only
```

## Direct document authoring

Files under `docs/` are normal project collaboration artifacts. Humans and
agents may write complete ADRs, RFCs, MVP plans, architecture documents, and
standards there directly. Observation and compilation do not gate drafting.

Registered documents use `protocol/project-document.schema.yaml`. Only
documents marked `accepted` after a direct human ruling become kg-compile
inputs. Ordinary Markdown remains valid and is ignored by Compile.

## Read isolation

Project instructions must tell work agents never to read `.kg/`. It contains
uncompiled claims and pipeline state. Writes go through kg-observe; reads
happen only in kg-compile sessions. `.cursorignore` is a secondary defense.

Project documents live under `docs/`, remain visible to work agents, and are
the normal collaboration surface.

## Platform discovery

- Cursor discovers `.agents/skills/`.
- Codex reads the host's human-authored `AGENTS.md`.
- Claude Code uses `.claude/skills/` and imports AGENTS.md through CLAUDE.md
  when the host already shows Claude markers.

The installer wires seven skills: kg-init, kg-observe, kg-compile, kg-scan,
kg-kickoff, kg-spec, and kg-docs. Symlink, copy, and registry layouts remain
self-contained.

## After installing

Tell the human what was created and which existing files were preserved.

- Greenfield: begin normal work and use kg-observe for reusable task signals.
- Brownfield: use the kg-docs bootstrap flow to create an evidence-backed
  architecture draft from a static repository inventory.
- Compile: run kg-compile when observations are due or accepted project
  documents need publication.
