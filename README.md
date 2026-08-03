# kg — Project Knowledge Growth

A platform-agnostic agent plugin, shipped as a skill collection, that turns
accepted project documents and the raw signals of agent work (human
corrections, task outcomes, test failures, review feedback) into compiled,
evidence-backed project knowledge, then routes it toward carriers agents
natively consume, including Markdown documents, skill proposals, and script
proposals.

> Local-first · Git-native · Evidence-driven · Agent-agnostic

The protocol design and all rulings live in
[`docs/rfc-001-project-knowledge-growth-protocol.md`](docs/rfc-001-project-knowledge-growth-protocol.md)
(Chinese — the incubation working language for human-facing docs; skill bodies,
schemas, and code are English).

## Why this project exists

Agents forget. Every session starts from zero: the same wrong assumption gets
corrected for the third time, the same test trap is rediscovered, the same
rejected design gets re-proposed. The signals that would prevent this — human
corrections, task outcomes, test failures, review feedback — are emitted
constantly during agent work, and then evaporate when the session ends.

The common countermeasure makes things worse: people append every lesson to
`AGENTS.md` / `CLAUDE.md` by hand until the context file is a swamp of stale,
unranked, contradictory prose that costs tokens every session and convinces
no one. Knowledge only ever grows; nothing verifies it, nothing retires it,
and nobody can tell an established contract from a passing remark.

kg treats this as a **compilation problem, not a memory problem**:

- **Complete documents stay complete.** Humans and agents directly draft ADRs,
  RFCs, architecture notes, and technical plans under `docs/`. Accepted
  registered documents become compiler sources; observation never gates
  authoring.
- **Claims need evidence.** An observation is claim + evidence + scope,
  recorded in-task in seconds. An opinion without a diff, test name, log
  excerpt, or quote is not knowledge.
- **A compiler judges, a collector doesn't.** Collection is light and never
  turns into an analysis session; a dedicated compile session dedupes,
  detects collisions, ranks authority, and routes each claim — with
  `no_change` as a legal, honest verdict (no fabricating lessons to look
  productive).
- **Publishing targets native carriers.** The v2 protocol separates
  observation-to-knowledge compilation from knowledge-to-harness routing.
  M1 defines Markdown document, skill proposal, and script proposal carriers
  without adding a retrieval runtime, database, or vector store.
- **Knowledge must also shrink.** A lifecycle state machine plus a mandatory
  subtraction duty (every compile round answers "what did we merge / demote /
  retire") and a regret log keep the corpus small enough to stay credible.
- **Humans rule where it matters.** Low-risk categories auto-activate;
  contracts and machine constraints stop at candidate until a human ruling,
  recorded git-native in a queue — no PR ceremony, no separate service.

Existing tools each cover a slice: workflow plugins write lessons back but
are platform-bound with no lifecycle or subtraction discipline; memory
infrastructure (vector/graph stores) solves recall but not governance, and
lives outside git review. kg's bet is that the five properties must hold
*simultaneously* — native-carrier injection, git-native governance, tiered
autonomy with lifecycle + regret, zero-engine pure-skill form, and a
prose-to-machine-constraint upgrade path.

The single hypothesis this incubation exists to test:

> Compiled project knowledge measurably reduces repeated corrections,
> repeated failures, and useless context injection.

This repo dogfoods the pipeline on itself — `knowledge/` and `.kg/` here are
real output, not fixtures.

## Layout

```text
skills/
  kg-init/      SKILL.md + scripts/ + assets/   setup, profiles, install
  kg-docs/      SKILL.md + scripts/   evidence-backed brownfield bootstrap
  kg-observe/   SKILL.md + scripts/   record observations (light, in-task)
  kg-compile/   SKILL.md + scripts/   compile observations into knowledge (heavy, dedicated session)
  kg-scan/      SKILL.md + scripts/ + references/   existing static-scan compatibility
  kg-kickoff/   SKILL.md + scripts/ + references/   M1 retrieval and grill spike
  kg-spec/      SKILL.md + scripts/   M1 zero-interview task-spec spike
protocol/       nine interfaces: observation, knowledge, project-document,
                harness and task-spec schemas, taxonomy, lifecycle, authority,
                and two-stage routing
scripts/lib/    shared Node stdlib modules (KYAML parser, validator, host and
                repository helpers, and protocol loaders); the SOURCE OF TRUTH; skill scripts
                reach it via each skill's scripts/_lib.mjs resolver
skills/*/scripts/lib/, skills/*/protocol/
                committed vendored copies of scripts/lib/ and protocol/ that make
                every skill dir self-contained (registry installers copy only the
                skill dir) — regenerated by scripts/sync-vendored.mjs, never
                hand-edited
docs/           RFCs plus direct-authoring architecture, API, glossary, and inventory docs
knowledge/      this repo's own compiled knowledge (kg dogfoods itself)
.kg/            this repo's own pipeline state (bootstrap artifacts, committed)
```

## Install (consumers)

Requires Node.js >= 18. Zero dependencies — no `npm install`, no `package.json`.

### Option A — `npx skills add` (recommended)

kg's skill dirs are self-contained, so the standard
[skills CLI](https://github.com/vercel-labs/skills) works out of the box:

```bash
# 1. from the host repo root, install the available skills into .agents/skills/
npx skills add brookszheng/kg

# 2. classify the host, complete wiring, and select a directory profile
node .agents/skills/kg-init/scripts/install.mjs \
  --docs-profile standard \
  --project-stage brownfield
```

Step 2 is required: the skills CLI only delivers the skill files; the
`.kg/` pipeline tree, the direct-authoring directory skeleton, and platform
wiring are created by kg-init. Detection owns the host classification, while
`--project-stage` remains a compatibility hint. Init creates only
`docs/README.md` as document content. Existing documents and human AGENTS
bytes are preserved. Commit everything it created.

`npx skills add owner/repo` installs from the repo's **default branch**.
To test a not-yet-merged branch, install from a local checkout instead
(branch names containing `/` do not survive the CLI's URL parsing):

```bash
git clone -b <branch> https://github.com/<owner>/kg /tmp/kg && npx skills add /tmp/kg
```

If a script fails with `cannot locate shared lib`, the installed copies
predate the self-contained layout — reinstall from an up-to-date source.

### Option B — from a local checkout of this repo

```bash
# default: symlink skills into <host>/.agents/skills/ (host follows plugin
# checkout updates automatically); add --copy to vendor self-contained copies
node skills/kg-init/scripts/install.mjs /path/to/host [--copy] \
  --docs-profile lean|standard|none \
  --project-stage greenfield|brownfield
```

### Agent platform coverage

- **Cursor** — discovers skills under `.agents/skills/` and reads project
  instructions from `AGENTS.md`.
- **Codex** — reads the human-authored `AGENTS.md` natively. No extra wiring.
- **Claude Code** — reads `CLAUDE.md` (not `AGENTS.md`) and discovers skills
  under `.claude/skills/`. When the host shows Claude markers (a `.claude/`
  dir or a `CLAUDE.md`), kg-init symlinks `.claude/skills/kg-*` to the
  canonical `.agents/skills/` copies and ensures `CLAUDE.md` imports
  `AGENTS.md` (creates a one-line `@AGENTS.md` file, or appends the import —
  existing content untouched).

## Upgrade (consumers)

- **Installed via `npx skills add`** — the CLI records the source in
  `skills-lock.json`; upgrading is:

  ```bash
  npx skills update          # refresh .agents/skills/kg-* from the source repo
  node .agents/skills/kg-init/scripts/install.mjs   # re-render wiring (idempotent)
  ```

  Updates replace only the skill dirs. Host state under `.kg/`, `knowledge/`,
  `docs/`, `AGENTS.md`, and `.cursorignore` is never touched by the skills
  CLI. Re-running kg-init verifies healthy v2 state and may restore missing
  managed empty directories. It does not refresh config, project documents,
  project instructions, or skill contents.

- **Symlink install (Option B default)** — `git pull` the plugin checkout;
  hosts pick it up through the symlinks, nothing else to do.
- **`--copy` install (Option B)** — use the explicit repair or update workflow
  when skill contents need refresh. A healthy v2 installer rerun verifies state
  without refreshing vendored skill dirs.

## Releasing (maintainers of this repo)

`scripts/lib/` and `protocol/` at the repo root are the source of truth; the
copies embedded in each `skills/<name>/` are what registry installs actually
ship. After editing either, regenerate and commit the vendored copies:

```bash
node scripts/lib/protocol.mjs
node scripts/sync-vendored.mjs          # refresh skills/*/scripts/lib + skills/*/protocol
node scripts/sync-vendored.mjs --check  # CI / pre-push guard: exit 1 on drift
node scripts/test-rfc004.mjs             # setup, document, and scan black-box tests
```

A skill published with drifted copies fails only at the consumer's site —
run the `--check` before pushing anything that touched `scripts/lib/`,
`protocol/`, or `skills/`.

## Daily use

Draft complete ADRs, RFCs, and technical plans directly under `docs/`.
Registered documents move through `draft`, `proposed`, `accepted`, `rejected`,
and `superseded`. Only a human can authorize `accepted`.

For an existing codebase:

```bash
node .agents/skills/kg-docs/scripts/inventory.mjs \
  --root . --output /path/to/artifacts/repository-inventory.json
node .agents/skills/kg-docs/scripts/bootstrap.mjs \
  --project-root . \
  --inventory /path/to/artifacts/repository-inventory.json \
  --plan /path/to/artifacts/bootstrap-plan.json
```

Follow `kg-docs/SKILL.md` to create the strict JSON plan. Version 2 creates one
missing draft for every taxonomy core type in one preflighted batch. The
architecture-only version 1 plan remains compatible. Static inventory executes
no host code and excludes `.kg/`, secrets, binaries, oversized files,
dependency and generated directories, and symbolic links.

Validate registered documents:

```bash
node .agents/skills/kg-compile/scripts/validate-project-documents.mjs
```

```bash
# during work, record an observation (see skills/kg-observe/SKILL.md)
printf '%s\n' \
  '{"source":"human_correction","claim":"...","evidence":[{"type":"quote","ref":"..."}]}' \
  | node .agents/skills/kg-observe/scripts/add-observation.mjs --stdin

# when the threshold reminder fires (or immediately for fast_track),
# run a compile session following skills/kg-compile/SKILL.md; it reads
# accepted registered documents, observations, and existing knowledge
```

Working agents must never read `.kg/` during tasks — writes go through
kg-observe only; reads happen only in kg-compile sessions. Host project
instructions carry this rule.

## KYAML — the machine-parsed YAML subset

There is no YAML dependency; all machine-parsed surfaces (protocol files,
config, observations, queue items, registered project-document frontmatter,
knowledge frontmatter) use **KYAML**, a strict subset implemented in
`scripts/lib/kyaml.mjs`:

- a document is a block mapping; 2-space indentation, no tabs;
- block lists (`- item`, one line per item), inline lists `[a, b]` and inline
  maps `{ k: v }` with **scalar values only** (no nesting inline collections —
  encode value lists as one pipe-separated string, e.g. `values: "a|b|c"`);
- scalars: bare tokens or double-quoted JSON strings (quote anything with
  `#`, quotes, or leading/odd characters);
- full-line comments only; no anchors, tags, or multiline scalars.

Anything outside the subset is a parse error — fix the file, not the parser.
