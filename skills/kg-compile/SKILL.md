---
name: kg-compile
description: Run a knowledge compile session — turn pending .kg/observations/ into published knowledge. Trigger when the observation threshold reminder fires, when a fast_track observation exists (human correction — compile that single item immediately), when a human asks for a compile/knowledge session, or periodically as a dedicated batch session. This is the ONLY context in which reading .kg/ is allowed.
---

# kg-compile — the compiler-agent role

You are the compiler of the kg pipeline (RFC-001). Compilation is HEAVY: it
runs as a dedicated session (or an immediate single-item run for fast_track),
never inline in a work task. You are the only role allowed to READ `.kg/`.

Language rule: knowledge entries, schemas, and queue file contents are
English. The compile report narrative and everything you say to the human
follow the human's language.

Read first: `protocol/routing.yaml` (verdict + categories + autonomy),
`protocol/authority.yaml` (conflict ranking), `protocol/lifecycle.yaml`
(legal transitions). Scripts live in `skills/kg-compile/scripts/`; run them
with `node <script>.mjs` from anywhere inside the host repo.

## Session procedure

### 1. Load inputs

- Check for a stale round log: if `.kg/reports/.round-actions.jsonl` exists
  at session start, a previous compile session died between writing its
  report and running `--clear-round`. Recovery: confirm the actions in it are
  covered by the latest report in `.kg/reports/`, then run
  `report-metrics.mjs --clear-round` before doing anything else — otherwise
  the leftover actions pollute this round's subtraction ratio.
- Validate the inbox: `node .../kg-observe/scripts/validate-observations.mjs`.
  Malformed observations are excluded from compilation; list them in the
  report for repair.
- Read every pending observation in `.kg/observations/` AND every existing
  entry in `knowledge/` (all lifecycle states — dedupe needs the full set).
  If platform ignore rules (e.g. the `.cursorignore` line kg-init writes)
  block your file-read tools from `.kg/`, read through the terminal or the
  skill scripts instead — the isolation rule targets work tasks, and this
  session is the sanctioned exception.

### 2. Judge each observation

Map every observation to the verdict or exactly one category
(`protocol/routing.yaml`):

- `no_change` — nothing reusable. Legal and common; produces no files, only a
  report line. Never stretch a weak observation into an entry to look
  productive.
- `project_knowledge` / `procedure` — auto-active tier.
- `project_contract` / `executable_constraint` — human-review tier.
- `needs_human_decision` — conflicting evidence or a major unknown; queue
  item only.

**Dedupe** against existing entries first: if an observation restates a known
claim, prefer `update` (refresh `last_verified`, extend evidence/scope of the
existing entry) over `add`. Multiple pending observations about one claim
compile into ONE entry citing all of them.

**Updates**: hand-editing an entry's evidence, scope, `last_verified`, claim
wording, or body — never `lifecycle:` — IS the sanctioned update mechanism;
there is no separate script for content edits. Every hand-edit must be logged
with `log-update.mjs <KN-id>` so the round's action log and report see it,
and re-validated with `validate-knowledge.mjs`.

**`human_decision` observations** carry the human's explicit in-conversation
ruling: cite the quoted decision as evidence and map authority to
`user_explicit_constraint` (the ruling itself) or `formal_decision` (the
resulting ADR-style entry). Rejected alternatives recorded with the decision
belong in the entry body — they prevent re-proposal.

**Collision detection**: when an observation contradicts an existing entry or
another observation, rank both sides with `protocol/authority.yaml`. The
ranking gives you a RECOMMENDATION — you must NEVER silently pick a side.
File a `kind: conflict` queue item (options + your recommendation), and if a
live entry is contested, transition it to `conflicted`.

### 3. Publish per autonomy tier

- **Auto tier** (`project_knowledge`, `procedure`): write a draft entry
  (frontmatter + English body — the entry IS the reference doc) and run
  `add-entry.mjs <draft.md>`. It validates, assigns the id, forces
  `lifecycle: active`, and logs the action.
- **Human-review tier** (`project_contract`, `executable_constraint`):
  `add-entry.mjs` creates the entry as `candidate`; then you MUST file a
  `kind: promotion` queue item via `add-queue-item.mjs`. Never activate these
  yourself. For `executable_constraint`, put the concrete test/lint/CI
  proposal in the entry body.
- **Always human-review**, whatever the category: any hand-edit to `AGENTS.md`
  beyond re-rendering, any proposal for a new skill (e.g. a mature procedure
  graduating to a skill) — `kind: proposal` queue item, and any new
  `scope.domains` value not in `protocol/domains.yaml` — `kind: proposal`
  with category `needs_human_decision`, then `add-domain.mjs` after acceptance.
- **Queue only** (`needs_human_decision`): `add-queue-item.mjs`; no entry.

**Domain vocabulary (RFC-002 S2):** `add-entry.mjs` rejects unknown
`scope.domains`. To propose a new domain: file a `kind: proposal` queue item
claiming the domain name + description; on human acceptance run
`add-domain.mjs <name> "<description>"`, sync vendored protocol copies in the
plugin source if applicable, then publish entries using the new domain.

Lifecycle changes (promote after a human accepts, demote, retire, merge,
conflict) go through `transition-entry.mjs` — it machine-validates against
`protocol/lifecycle.yaml`: `--regret` is required on demotion, and archiving
from a live state (candidate/active/conflicted) requires `--superseded-by`
(merge — the survivor's `supersedes` back-pointer is written for you) OR
`--regret` (direct retire). If it rejects a transition, the transition is
illegal; fix the plan, not the validator.

Apply pending human rulings at the start of publishing: for each `.kg/queue/`
item whose `resolution` is no longer `pending`, execute the ruling
(promote/reject the entry, or implement the accepted proposal).

### 4. Subtraction duty (mandatory)

Every compile run MUST explicitly answer: **"what did we merge / demote /
retire / rescope this round?"** An empty answer is allowed but must be written in the
report — silence is a protocol violation. Actively look for: entries
superseded by newer ones (merge: archive the loser with `--superseded-by`),
entries that proved wrong (demote with `--regret`), deprecated entries past
their usefulness (retire to archived), prose entries that became machine
constraints (propose the constraint, then retire the prose once it lands),
entries that fail the line budget (rescope: move global claim lines toward
domain-folded rows, sink path-scoped knowledge to subdirectory blocks, or
leave pointer-only reachability at root per RFC-002 R3/R4).

### 5. Report, render, archive

1. Compute metrics: `node .../report-metrics.mjs` (embed its block verbatim).
2. Write `.kg/reports/REPORT-<YYYYMMDD>-<n>.md` in the user's language:
   observations processed and their verdict/category mapping, entries
   added/updated, the subtraction answer, the four metrics, malformed
   observations needing repair, and the **ruling checklist** — every pending
   `.kg/queue/` item with its recommendation. The checklist is the ASYNC
   path; when a human is present, run the ruling interview (§6) instead of
   ending on a checklist dump.
3. Re-render the full `AGENTS.md`: `node .../render-agents.mjs` (RFC-002 S3
   assembles intent/layout/conventions + the kg managed block; `--check`
   detects code-export drift). If any section budget fails, that is the
   context-bloat alarm — go back to step 4 and subtract or rescope more; do
   not raise the budget.
4. Archive processed observations:
   `node .../archive-observations.mjs <OBS-id>...` (or `--all` if every
   pending observation was handled). Malformed/deferred ones stay in the
   inbox.
5. Clear the round log: `node .../report-metrics.mjs --clear-round`.

### 6. Ruling interview (when a human is present)

The queue file is the RECORD; the conversation is the INTERFACE. Compile
sessions are usually human-triggered, so end them by interviewing, not by
telling the human to go read `.kg/queue/`:

- Present pending queue items **one at a time** (more than 3: give a compact
  ballot first — one line each — then expand items on request). For each
  item present: the claim in one line; what changes if accepted (which
  carrier it lands in, what it will bind); the evidence **quoted verbatim**
  (never paraphrase — cite the queue file path so the human can audit); the
  options; your recommendation and why.
- Accept conversational rulings ("accept", "option 2", "reject because...").
  "Defer" — or no answer — is always legal: the item stays pending; never
  re-ask or broaden a deferred item in the same session.
- Execute each ruling immediately: set `resolution`, record the human's
  exact words in `resolution_note`, run `transition-entry.mjs`, re-render,
  re-validate, and show the outcome before moving to the next item.
- Unattended sessions: skip the interview — the report's ruling checklist
  and the queue files are the async path. A human can rule later in ANY
  session: an agent asked to "process the kg queue" (「处理裁决队列」)
  follows this same interview procedure without running a compile round.

## Fast-track runs

A `fast_track` observation (human correction) gets this same procedure
scoped to that single observation — do it immediately, keep it small, and
still write a (short) report. Human corrections usually carry
`user_explicit_constraint` authority: check for collisions with existing
entries every time, because a correction contradicting active knowledge is
exactly how regret gets recorded.

## Hard rules

- Never edit files in `.kg/observations/` — the inbox is append-only; you
  only move processed files via `archive-observations.mjs`.
- Never hand-edit `AGENTS.md`; edit knowledge entries / section mapping and
  re-render (`render-agents.mjs` writes the full document).
- Never bypass `transition-entry.mjs` by editing `lifecycle:` by hand.
- Conflicts always reach the queue: authority ranks, humans rule.
- In a ruling interview, evidence is quoted verbatim, never paraphrased;
  the human's ruling words go into `resolution_note` for audit.
