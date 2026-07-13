<!-- kg:begin -->
kg (Project Knowledge Growth) — managed block, rendered from `knowledge/`. Do not edit by hand.

- HARD RULE: never read `.kg/` during a work task — it holds uncompiled claims and pipeline state. Writes go only through the kg-observe skill; reads happen only inside kg-compile sessions.
- Record observations (task end, or IMMEDIATELY on human correction): `.agents/skills/kg-observe/SKILL.md`.
- Compile pending observations into knowledge: `.agents/skills/kg-compile/SKILL.md`.

Active project knowledge (read the entry before working in its scope):

- KN-0001 [project_knowledge] KYAML inline maps cannot contain lists; schema field specs encode enums as one pipe-separated string. → `knowledge/KN-0001-kyaml-inline-maps-cannot-contain-lists.md`
- KN-0002 [project_knowledge] Record scripts validate the RAW input first (rejecting unknown fields), then rebuild in canonical field order before writing; kyaml.stringify preserves insertion order. → `knowledge/KN-0002-build-records-in-canonical-field-order.md`
- KN-0003 [project_contract] Skill scripts must reach shared code only via the _lib.mjs resolver, and every install mode — checkout, --copy, and registry (npx skills add) — must preserve the lib/../../protocol layout; registry installers copy ONLY the skill directory, so scripts/lib/ and protocol/ are committed vendored inside every skills/<name>/ and scripts/sync-vendored.mjs (--check) guards drift. → `knowledge/KN-0003-skill-scripts-must-reach-shared-code.md`
- KN-0004 [project_contract] A host repo's installed kg layout is .agents/skills/kg-* self-contained copies only; the root checkout layout (skills/ protocol/ scripts/) belongs exclusively to the plugin source repo. → `knowledge/KN-0004-a-host-repo-s-installed-kg.md`
- KN-0005 [project_knowledge] Destructive refresh (rm-then-copy) must first prove src and dest differ by canonical identity — fs.realpathSync with a resolve fallback for not-yet-existing paths; vendored re-runs and symlink aliases both collapse src==dest. → `knowledge/KN-0005-destructive-refresh-rm-then-copy-must.md`
- KN-0006 [project_knowledge] npx skills add owner/repo distributes the repo's DEFAULT branch only; unmerged branch fixes never reach consumers, and branch URLs whose branch name contains a slash fail the CLI's parsing — test unmerged branches from a local clone. → `knowledge/KN-0006-npx-skills-add-owner-repo-distributes.md`
- KN-0007 [project_knowledge] Node ESM resolves import.meta.url through symlinks, so argv[1]-vs-import.meta.url main-module checks must realpath argv[1] first — otherwise symlink-installed scripts silently skip their CLI entrypoint (exit 0, no output). → `knowledge/KN-0007-node-esm-resolves-import-meta-url.md`
- KN-0008 [project_knowledge] Claude Code reads CLAUDE.md (never AGENTS.md) and discovers skills under .claude/skills/; kg-init wires both — .claude/skills/kg-* symlinks to the canonical .agents/skills/ copies plus an @AGENTS.md import in CLAUDE.md — but only when the host shows Claude markers (.claude/ dir or CLAUDE.md). → `knowledge/KN-0008-claude-code-reads-claude-md-never.md`
<!-- kg:end -->
