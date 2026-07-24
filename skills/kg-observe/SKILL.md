---
name: kg-observe
description: Record a knowledge observation into the host repo's .kg/observations/ inbox. Trigger at the END of every work task (before declaring it done, review the task for reusable signals), IMMEDIATELY whenever the human corrects the agent (human corrections are fast-track, captured on the spot mid-task), whenever the human explicitly asks to record knowledge ("note this", "记一下", "record this decision"), and at the natural wrap-up of a knowledge-creation session (architecture design, directory layout, tech selection, spec discussion) — proactively OFFER to record the decisions made, one observation per decision. Also applies when a test failure, review comment, or task outcome reveals something project-specific and reusable.
---

# kg-observe — capture raw knowledge signals

You are the collection side of the kg pipeline (RFC-001). Collection is
LIGHT: it happens inline in a work task and never turns into an analysis
session. You record observations; a separate kg-compile session judges them.

Language rule: observation files, schemas, and code are English. Anything you
say TO the human follows the human's language.

## When to record

1. **Human correction — record IMMEDIATELY, mid-task.** The moment the human
   corrects you (wrong assumption, wrong approach, missed constraint), capture
   it before continuing work. Source `human_correction` defaults to
   `urgency: fast_track`.
2. **End of task.** Before declaring a task done, spend one minute asking:
   did this task teach anything a future agent would need? Sources:
   `task_outcome`, `test_failure`, `review`, `agent_insight`.
3. **Explicit human request.** "Note this" / "记一下" / "record this decision"
   — record whatever the human points at, on the spot, no judgment call
   needed on whether it qualifies.
4. **Knowledge-creation sessions.** Some conversations ARE the work:
   architecture design, directory-structure discussion, tech selection, spec
   rulings. These have no "task done" moment, so at the natural wrap-up
   (topic settled, human moving on) proactively offer: "this discussion
   produced N decisions — record them into kg?" Wait for the human's
   go-ahead; then record one observation per decision (see below).

## Decision capture (source: `human_decision`)

A design discussion that settles 5 decisions yields 5 observations — never
one blob for the whole conversation.

- **claim** = the decision itself, as a normative statement ("The web app
  uses feature-directory structure; features never import each other."),
  not a meeting summary.
- **evidence** — `type: quote` of the human's ruling words; ALSO record the
  rejected alternatives and why ("rejected: flat src/, because...") — a
  rejected option is knowledge too, it stops future agents from re-proposing
  it.
- `source: human_decision` defaults to `urgency: batch`. If the decisions
  must bind the very next tasks (typical for a new project's first
  architecture session), suggest running a kg-compile session right after
  recording instead of waiting for the threshold.
- Contract-category decisions (structure, boundaries) will still pass
  through candidate + human queue ruling at compile time even though the
  human just made them — that second confirmation is by design (git audit
  trail, and a guard against the agent misreading the conversation).

## Project document boundary

Observation is the intake format for continuous learning signals. It is not a
required precursor for complete project documents.

Humans and agents may directly draft and revise ADRs, RFCs, MVP technical
plans, architecture documents, glossaries, and standards under `docs/`.
Observer may later capture a reusable lesson from that work. Accepted
registered documents also enter kg-compile directly.

Do not decompose a document request into observations before writing the
document. Do not record every paragraph or scan finding as an observation.

## `no_change` is a legal and common outcome

If the review honestly finds nothing reusable, record **nothing** — do not
fabricate an observation to look diligent. `no_change` is a compile-time
verdict, not an observation type; an empty-handed collection pass simply
writes no file. Never invent claims to fill a quota.

## What makes a good observation

Claim + evidence + scope. One observation = one claim.

- **claim** — one sentence, normative or factual, self-contained. Bad:
  "the build was weird". Good: "Vitest workspace config must list every
  package dir explicitly; globs silently skip new packages."
- **evidence** — at least one concrete ref: a diff, a test name, a log
  excerpt, or a quote (for human corrections, quote the human's words).
  An opinion without evidence is not an observation.
- **scope** — `context.paths` (globs) and/or `context.task` so the compiler
  can judge where the claim applies.
- Project-specific and reusable. General world knowledge ("HTTP 404 means
  not found") is noise — skip it.

## How to record

Write a KYAML draft (see `protocol/observation.schema.yaml`; strict subset —
quote strings containing `#` or special characters), then append it:

```bash
node <plugin>/skills/kg-observe/scripts/add-observation.mjs draft.yaml
# or pipe:  ... | node .../add-observation.mjs --stdin
```

Draft template (`id`/`at`/`urgency` may be omitted — the script fills them):

```yaml
source: human_correction
claim: "One-shot URL params must be consumed by a single coordinator."
context:
  task: menu-filters
  paths: [src/app/menu/**]
evidence:
  - { type: quote, ref: "human: only one consumer may clear the param" }
```

The script validates against the schema and REJECTS malformed drafts with an
error list; fix the draft and retry — never hand-write files into
`.kg/observations/`.

## Fast-track flow (human corrections)

`urgency: fast_track` means: do not wait for the batch threshold. After the
script confirms the write, it will remind you to start an **immediate
kg-compile session for that single observation** (see `skills/kg-compile/`).
If you are mid-task, finish the current edit first, then run the fast-track
compile before task end.

## Threshold check

`add-observation.mjs` prints the pending count after every write. To check on
demand:

```bash
node <plugin>/skills/kg-observe/scripts/check-threshold.mjs
```

When pending ≥ `observation_threshold` (`.kg/config.yaml`), remind the human
that a batch kg-compile session is due. The reminder never blocks work.

## Hard rules

- `.kg/observations/` is **append-only** and written **only** through
  `add-observation.mjs`. One file per observation (`<id>.yaml`).
- Do not read `.kg/` for task context — the read-isolation rule in the host
  AGENTS.md applies to you too. You only WRITE observations here.
- Do not edit or delete existing observations; corrections are new
  observations. Only kg-compile moves files (into `observations/processed/`).
