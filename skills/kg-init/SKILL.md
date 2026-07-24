---
name: kg-init
description: Install and set up the kg (Project Knowledge Growth) pipeline and optional project-document profiles in a host repository. MANUAL INVOCATION ONLY: run this skill exclusively when a human explicitly asks to set up, install, initialize, configure, or repair kg, knowledge growth, a project documentation baseline, or the brownfield bootstrap flow. Never auto-trigger it from inferred context; report a broken or missing install and wait for explicit human approval. The installer is idempotent and preserves existing project documents.
disable-model-invocation: true
---

# kg-init

Installing kg mutates the host repository's `AGENTS.md`, ignore files, skill
wiring, and optional document baseline. Require an explicit human request.

## Setup interview

Before a first install, resolve two choices. Ask only when the user has not
already provided the answer:

1. Project stage: `greenfield` or `brownfield`.
2. Document profile: `lean`, `standard`, or `none`.

Recommend `standard` for a normal long-lived project. Recommend `lean` for a
small or short-lived project. Use `none` when the host already has a deliberate
documentation system and only needs KG wiring.

For brownfield, finish installation first, then continue with `kg-scan`.
Semantic scanning stays outside the deterministic installer.

## Install

```bash
node <plugin>/skills/kg-init/scripts/install.mjs [host-root] [--copy] \
  [--threshold N] [--budget N] \
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
interview should pass the selected profile explicitly.

The installer is idempotent. It never duplicates the managed block, overwrites
`.kg/config.yaml`, replaces an existing project document, or changes
`AGENTS.md` content outside the anchors.

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
  glossary.md
  standards/               standard profile
  development.md           standard profile
AGENTS.md                  kg managed block
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

The managed block tells work agents never to read `.kg/`. It contains
uncompiled claims and pipeline state. Writes go through kg-observe; reads
happen only in kg-compile sessions. `.cursorignore` is a secondary defense.

Project documents live under `docs/`, remain visible to work agents, and are
the normal collaboration surface.

## Platform discovery

- Cursor discovers `.agents/skills/`.
- Codex follows pointers in the AGENTS managed block.
- Claude Code uses `.claude/skills/` and imports AGENTS.md through CLAUDE.md
  when the host already shows Claude markers.

The installer wires all four skills: kg-init, kg-observe, kg-compile, and
kg-scan. Symlink, copy, and registry layouts remain self-contained.

## After installing

Tell the human what was created and which existing files were preserved.

- Greenfield: begin normal work and use kg-observe for reusable task signals.
- Brownfield: run kg-scan to draft architecture, API, glossary, and document
  inventory files from the existing code.
- Compile: run kg-compile when observations are due or accepted project
  documents need publication.
