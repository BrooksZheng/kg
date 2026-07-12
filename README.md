# kg — Project Knowledge Growth

A platform-agnostic agent plugin, shipped as a skill collection, that turns the raw
signals of agent work (human corrections, task outcomes, test failures, review
feedback) into compiled, evidence-backed project knowledge — and publishes that
knowledge into the carriers agents natively consume (`AGENTS.md`, reference docs,
skills, executable constraints).

> Local-first · Git-native · Evidence-driven · Agent-agnostic

The protocol design and all rulings live in
[`docs/rfc-001-project-knowledge-growth-protocol.md`](docs/rfc-001-project-knowledge-growth-protocol.md)
(Chinese — the incubation working language for human-facing docs; skill bodies,
schemas, and code are English).

## Layout

```text
skills/
  kg-init/      SKILL.md + scripts/   install kg into a host repo (idempotent)
  kg-observe/   SKILL.md + scripts/   record observations (light, in-task)
  kg-compile/   SKILL.md + scripts/   compile observations into knowledge (heavy, dedicated session)
protocol/       the five fixed interfaces: observation & knowledge schemas,
                lifecycle state machine, authority ranking, routing table
scripts/lib/    shared Node stdlib modules (KYAML parser, validator, host helpers,
                AGENTS block renderer) — single copy; skill scripts reach it via
                each skill's scripts/_lib.mjs resolver, and `kg-init --copy`
                embeds it (plus protocol/) into vendored skill dirs
docs/           the RFC — protocol design, rulings, and task ledger
knowledge/      this repo's own compiled knowledge (kg dogfoods itself)
.kg/            this repo's own pipeline state (bootstrap artifacts, committed)
```

## Quickstart

Requires Node.js >= 18. Zero dependencies — no `npm install`, no `package.json`.

```bash
# 1. install into a host repo (default: symlink skills into .agents/skills/;
#    add --copy to vendor self-contained copies)
node skills/kg-init/scripts/install.mjs /path/to/host

# 2. during work, record an observation (see skills/kg-observe/SKILL.md)
printf '%s\n' \
  'source: human_correction' \
  'claim: "..."' \
  'evidence:' \
  '  - { type: quote, ref: "..." }' \
  | node .agents/skills/kg-observe/scripts/add-observation.mjs --stdin

# 3. when the threshold reminder fires (or immediately for fast_track),
#    run a compile session following skills/kg-compile/SKILL.md
```

Working agents must never read `.kg/` during tasks — writes go through
kg-observe only; reads happen only in kg-compile sessions (the managed block
in the host `AGENTS.md` carries this rule).

## KYAML — the machine-parsed YAML subset

There is no YAML dependency; all machine-parsed surfaces (protocol files,
config, observations, queue items, knowledge frontmatter) use **KYAML**, a
strict subset implemented in `scripts/lib/kyaml.mjs`:

- a document is a block mapping; 2-space indentation, no tabs;
- block lists (`- item`, one line per item), inline lists `[a, b]` and inline
  maps `{ k: v }` with **scalar values only** (no nesting inline collections —
  encode value lists as one pipe-separated string, e.g. `values: "a|b|c"`);
- scalars: bare tokens or double-quoted JSON strings (quote anything with
  `#`, quotes, or leading/odd characters);
- full-line comments only; no anchors, tags, or multiline scalars.

Anything outside the subset is a parse error — fix the file, not the parser.
