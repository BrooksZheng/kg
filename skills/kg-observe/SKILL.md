---
name: kg-observe
description: Record a knowledge observation into the host repo's .kg/observations/ inbox. Trigger at the END of every work task (before declaring it done, review the task for reusable signals), and IMMEDIATELY whenever the human corrects the agent — human corrections are fast-track and must be captured on the spot, mid-task. Also applies when a test failure, review comment, or task outcome reveals something project-specific and reusable.
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
