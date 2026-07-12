---
name: kg-init
description: Install the kg (Project Knowledge Growth) pipeline into a host repository. Trigger when a human asks to set up / install / initialize kg (or "knowledge growth", "知识管道") in a repo, when adopting the kg plugin in a new project, or when the kg directories (.kg/, knowledge/) or the AGENTS.md managed block are missing or damaged and need repair — the installer is idempotent and safe to re-run.
---

# kg-init — install kg into a host repo

One command:

```bash
node <plugin>/skills/kg-init/scripts/install.mjs [host-root] [--copy] [--threshold N] [--budget N]
```

`host-root` defaults to `$KG_ROOT` or the current directory. The installer is
**idempotent** — running it twice changes nothing the second time; it never
duplicates the anchor block, never overwrites an existing `.kg/config.yaml`,
and never touches AGENTS.md content outside the anchors.

## What gets installed

```text
.kg/                     pipeline state — working agents MUST NOT read this
  config.yaml            observation_threshold, agents_block_budget_lines, skills_path
  observations/          append-only inbox (kg-observe writes here)
  observations/processed/  compiled observations (kg-compile moves them here)
  queue/                 human ruling queue (git-native)
  reports/               compile reports with metrics
knowledge/               knowledge entries = source of truth, git-tracked
AGENTS.md                kg managed block planted between anchors
.cursorignore            `.kg/` line added (best-effort secondary defense)
.agents/skills/kg-*      Cursor-native skill discovery (symlink or copy)
```

## The managed block and read isolation

The installer plants `<!-- kg:begin -->` / `<!-- kg:end -->` anchors in the
host `AGENTS.md` (creating the file if absent, appending if present) and
renders the resident block: the `.kg/` read-isolation hard rule, pointers to
kg-observe / kg-compile, and an index of active knowledge entries.

The read-isolation rule is the system's main defense: `.kg/` holds
**uncompiled, unverified claims** — a working agent reading them mid-task
injects unreviewed knowledge past the entire compile → tier → publish
pipeline. Writes go only through kg-observe; reads happen only in kg-compile
sessions. The `.cursorignore` entry is a secondary, best-effort defense only
(ignore semantics differ per platform — never rely on it alone).

## Platform discovery

- **Cursor**: skills are discoverable under `.agents/skills/`. Default is a
  relative symlink to the plugin checkout; pass `--copy` to vendor
  self-contained copies (each copied skill embeds `scripts/lib/` and
  `protocol/`) when the host repo cannot reference the plugin directory.
- **Codex**: no wiring needed — the AGENTS.md managed block is injected every
  session and its pointer lines lead to the skill files.
- A new platform = a new discovery path only; no logic changes.

## After installing

Tell the human (in their language) where things landed and what happens
next: agents record observations at task end and on corrections
(kg-observe); when the pending count reaches the threshold, a compile
session (kg-compile) turns them into knowledge entries and re-renders the
AGENTS.md index. All state is git-tracked — commit the installed files.
