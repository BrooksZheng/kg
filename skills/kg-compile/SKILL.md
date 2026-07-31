---
name: kg-compile
description: Run a knowledge compile session that turns pending .kg/observations/ and accepted registered project documents into published atomic knowledge. Trigger when the observation threshold reminder fires, a fast_track correction exists, a human accepts an ADR/RFC/project document and asks to publish it, a human asks for a compile or knowledge session, or a periodic dedicated batch is due. This is the ONLY context in which reading .kg/ is allowed.
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

## M2 deterministic plan/apply path

This section overrides the older per-record publishing instructions below for
the M2-supported path. The compiler agent produces one strict JSON plan. It
never writes a KN, queue item, carrier, sidecar, processed observation, or
report directly.

1. Run `compile.mjs --root <host> --output <session-artifacts>/compile-context.json`.
   Keep the context outside `.kg/`. The script records independent input
   fingerprints for every pending observation, all KN entries, accepted
   project documents, harness sidecars, and carrier targets.
2. Read every file declared by the context. Submit one JSON
   `kg.compile_plan` with a non-shell file-writing tool. Each observation item
   must explicitly select exactly one result:
   `publish_kn_and_carrier`, `queue_only`, or `no_change`.
3. Run `apply-compile-plan.mjs --root <host> --context <context.json>
   --plan <plan.json>`. Use `--check` for deterministic preflight or final
   state verification. The apply script assigns IDs, timestamps, hashes,
   lifecycle, paths, trace fields, queue record fields, and report paths.

The plan top level is exactly `kind`, `version`, and `items`.

- `publish_kn_and_carrier` has `observation_id`, `result_type`, `knowledge`,
  and `carrier`. `knowledge` has `claim`, `category`, `scope`, `authority`,
  `confidence`, and `body`. `carrier` has `artifact_id` and `content`.
- `queue_only` has `observation_id`, `result_type`, and `queue`. `queue` has
  `claim`, `evidence`, `options`, and `recommendation`.
- `no_change` has `observation_id`, `result_type`, and `reason`.

M2 publication supports one auto-tier `project_knowledge` observation to one
active KN and one `ownership: managed`, `update_policy: automatic` Markdown
block. Queue-only and no-change observations may share the plan. Update,
merge, conflict mutation, candidate publication, co-managed or human targets,
and skill or script proposals remain deferred. Do not approximate those paths
with direct writes.

The apply script calls `archive-observations.mjs` once per completed
observation and records the exact arguments in the machine report. The report
also records the M2 known limitation: deterministic validation proves
reference existence and managed-block hash consistency, while semantic
equivalence between rendered prose and `source_kn_ids` remains for the M5
agent-assisted scan.

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
- Validate registered project documents:
  `node .../kg-compile/scripts/validate-project-documents.mjs`. Ordinary
  Markdown is ignored. Draft, proposed, rejected, and superseded registered
  documents remain valid project artifacts but are not compile inputs.
- List accepted sources with
  `node .../validate-project-documents.mjs --list-accepted` and read every
  listed document. These files live under `docs/`, outside `.kg/`, and remain
  directly editable through their normal review lifecycle.
- Read every pending observation in `.kg/observations/` AND every existing
  entry in `knowledge/` (all lifecycle states — dedupe needs the full set).
  If platform ignore rules (e.g. the `.cursorignore` line kg-init writes)
  block your file-read tools from `.kg/`, read through the terminal or the
  skill scripts instead — the isolation rule targets work tasks, and this
  session is the sanctioned exception.

### 2. Judge each source

For an accepted project document:

- Extract one or more atomic claims. A complete ADR or RFC can produce several
  entries while remaining the narrative source.
- Cite the exact document path and section in each entry's evidence. Keep
  design narrative, alternatives, and discussion history in the source
  document.
- Use `formal_decision` authority. Use `user_explicit_constraint` only when
  the accepted document or recorded ruling contains the human's explicit
  binding words.
- If every relevant claim is already represented by entries that cite the
  unchanged document, record `no_change` for that source.
- Never compile draft or proposed documents.
- Never rewrite an accepted source as part of compilation. Propose a normal
  document patch when source content needs correction.

Map every observation to the verdict or exactly one category
(`protocol/routing.yaml`):

- `no_change` — nothing reusable. Legal and common; produces no files, only a
  report line. Never stretch a weak observation into an entry to look
  productive.
- `project_knowledge` / `procedure` — auto-active tier.
- `project_contract` / `executable_constraint` — human-review tier.
- `needs_human_decision` — conflicting evidence or a major unknown; queue
  item only.

**Dedupe** every extracted claim against existing entries first. If a source
restates a known claim, prefer `update` (refresh `last_verified`, extend
evidence/scope of the existing entry) over `add`. Multiple observations or
documents about one claim compile into ONE entry citing all relevant sources.

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
- **Always human-review**, whatever the category: any proposal for a new
  skill or script, and any change to a human-owned document. File a
  `kind: proposal` queue item.
- **Queue only** (`needs_human_decision`): `add-queue-item.mjs`; no entry.

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
retire this round?"** An empty answer is allowed but must be written in the
report — silence is a protocol violation. Actively look for: entries
superseded by newer ones (merge: archive the loser with `--superseded-by`),
entries that proved wrong (demote with `--regret`), deprecated entries past
their usefulness (retire to archived), prose entries that became machine
constraints (propose the constraint, then retire the prose once it lands).

### 5. Report and archive

1. Compute metrics: `node .../report-metrics.mjs` (embed its block verbatim).
2. Write `.kg/reports/REPORT-<YYYYMMDD>-<n>.md` in the user's language:
   accepted documents and observations processed, their claim/category
   mapping, entries added/updated, the subtraction answer, the four metrics,
   malformed sources needing repair, and the **ruling checklist** — every
   pending `.kg/queue/` item with its recommendation. The checklist is the ASYNC
   path; when a human is present, run the ruling interview (§6) instead of
   ending on a checklist dump.
3. Archive processed observations:
   run `node .../archive-observations.mjs --observation <OBS-id>
   --compiled-to-kn <KN-id>` for an observation that produced a KN. For
   `no_change` or `needs_human_decision`, run the same command with
   `--verdict <routing-verdict>` in place of `--compiled-to-kn`. The script
   loads legal no-KN verdicts from `protocol/routing.yaml`, writes a canonical
   processed copy without `compiled_to_kn`, and then removes the untouched
   pending original. Exactly one result option is required.
   Malformed or deferred observations stay in the inbox.
4. Clear the round log: `node .../report-metrics.mjs --clear-round`.

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
  exact words in `resolution_note`, run `transition-entry.mjs`, re-validate,
  and show the outcome before moving to the next item.
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

- Never edit files in `.kg/observations/`. The inbox is append-only.
  Processed copies are created only through `archive-observations.mjs`.
- Never treat ordinary, draft, or proposed project documents as accepted
  authority.
- Never require an observation before a human or agent can draft a complete
  ADR, RFC, MVP plan, or technical document under `docs/`.
- Never bypass `transition-entry.mjs` by editing `lifecycle:` by hand.
- Conflicts always reach the queue: authority ranks, humans rule.
- In a ruling interview, evidence is quoted verbatim, never paraphrased;
  the human's ruling words go into `resolution_note` for audit.
