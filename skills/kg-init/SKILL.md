---
name: kg-init
description: Install the kg (Project Knowledge Growth) pipeline into a host repository. MANUAL INVOCATION ONLY — run this skill exclusively when a human explicitly asks to set up / install / initialize / repair kg (or "knowledge growth", "知识管道") in a repo. Never auto-trigger it from inferred context (missing .kg/ directories, damaged anchors, etc.); if you detect a broken install, report it to the human and wait for their explicit go-ahead. The installer is idempotent and safe to re-run.
disable-model-invocation: true
---

# kg-init — install kg into a host repo

> **Manual trigger only.** Installing kg mutates the host repo's `AGENTS.md`,
> ignore files, and skill wiring — that is a human decision. Platforms that
> honor `disable-model-invocation` enforce this mechanically; on platforms
> that don't (Cursor, Codex), the description above is the binding rule:
> an explicit human request is the only valid trigger.

One command:

```bash
node <plugin>/skills/kg-init/scripts/install.mjs [host-root] [--copy] [--threshold N] [--budget N]
```

When the skills arrived via a registry installer (`npx skills add`), they
already sit vendored under `.agents/skills/kg-*` — run the installer from
there to complete the host wiring (skill discovery is detected as already in
place and skipped):

```bash
node .agents/skills/kg-init/scripts/install.mjs
```

`host-root` defaults to `$KG_ROOT` or the current directory. The installer is
**idempotent** — running it twice changes nothing the second time; it never
duplicates the anchor block, never overwrites an existing `.kg/config.yaml`,
and re-renders `AGENTS.md` as a full compiled document (RFC-002 S3).

## What gets installed

```text
.kg/                     pipeline state — working agents MUST NOT read this
  config.yaml            observation_threshold, agents_block_budget_lines,
                         agents_block_budget_lines_subdir, skills_path
  observations/          append-only inbox (kg-observe writes here)
  observations/processed/  compiled observations (kg-compile moves them here)
  queue/                 human ruling queue (git-native)
  reports/               compile reports with metrics
knowledge/               knowledge entries = source of truth, git-tracked
AGENTS.md                full rendered document (intent/layout/conventions + kg block)
.cursorignore            `.kg/` line added (best-effort secondary defense)
.agents/skills/kg-*      canonical skill discovery (symlink or copy)
.claude/skills/kg-*      Claude Code discovery — symlinks to .agents/skills/,
                         only when the host shows Claude markers
CLAUDE.md                `@AGENTS.md` import ensured (Claude-marker hosts only)
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
- **Claude Code**: reads `CLAUDE.md` (not `AGENTS.md`) and discovers skills
  under `.claude/skills/`. When the host has a `.claude/` dir or a
  `CLAUDE.md`, the installer symlinks `.claude/skills/kg-*` to the canonical
  `.agents/skills/` copies (symlinks planted by `npx skills add` are
  recognized and left alone) and ensures `CLAUDE.md` carries the officially
  recommended `@AGENTS.md` import so the managed block reaches Claude
  sessions. Hosts without Claude markers are left untouched.
- A new platform = a new discovery path only; no logic changes.

## After installing

Tell the human (in their language) where things landed and what happens
next: agents record observations at task end and on corrections
(kg-observe); when the pending count reaches the threshold, a compile
session (kg-compile) turns them into knowledge entries and re-renders the
AGENTS.md index. All state is git-tracked — commit the installed files.
