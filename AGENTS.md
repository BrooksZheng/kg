# Project context

_Rendered by kg — do not edit by hand. Supply changes via knowledge entries, observations, or `protocol/agents-sections.yaml`; re-run render-agents.mjs._

## Repository layout

```text
skills/         agent skills (kg-init, kg-observe, kg-compile)
protocol/       schemas, lifecycle, routing, domains
scripts/lib/    shared Node modules — source of truth
knowledge/      compiled knowledge entries
.kg/            pipeline state (never read during work tasks)
docs/           RFC and design docs
```

## Conventions

### KN-0003

## Contract
Two layout invariants keep skills runnable in both the plugin checkout and a
vendored (`--copy`) install:
1. Every skill script imports shared code through its local `_lib.mjs`
   resolver (candidates: `../../../scripts/lib/`, then `./lib/`). Never
   import `scripts/lib/*` by a hardcoded relative path from a skill script.
2. `protocol/` is resolved as `<lib>/../../protocol`. Any new install mode or
   repo reshuffle must preserve that relationship — this is exactly why

### KN-0004

## Contract
Two layouts exist and must never be conflated:
- **Plugin source repo** (development): `skills/`, `protocol/`, `scripts/lib/`
  at the repo root. This is where kg itself is built.
- **Installed host repo** (consumption): everything lives under
  `.agents/skills/kg-*/` as self-contained vendored copies (each skill embeds
  `scripts/lib/` and `protocol/`), produced by `kg-init --copy`. The host
  root gains only `.kg/`, `knowledge/`, the AGENTS.md managed block, and the


<!-- kg:begin -->
kg (Project Knowledge Growth) — managed block, rendered from `knowledge/`. Do not edit by hand.

- HARD RULE: never read `.kg/` during a work task — it holds uncompiled claims and pipeline state. Writes go only through the kg-observe skill; reads happen only inside kg-compile sessions.
- Record observations (task end, or IMMEDIATELY on human correction): `.agents/skills/kg-observe/SKILL.md`.
- Compile pending observations into knowledge: `.agents/skills/kg-compile/SKILL.md`.

Active project knowledge (read the entry before working in its scope):

- KN-0003 [project_contract] Skill scripts must reach shared code only via the _lib.mjs resolver, and both install modes must preserve the lib/../../protocol layout. → `knowledge/KN-0003-skill-scripts-must-reach-shared-code.md`
- KN-0004 [project_contract] A host repo's installed kg layout is .agents/skills/kg-* self-contained copies only; the root checkout layout (skills/ protocol/ scripts/) belongs exclusively to the plugin source repo. → `knowledge/KN-0004-a-host-repo-s-installed-kg.md`
- [protocol] KN-0001 → `knowledge/KN-0001-kyaml-inline-maps-cannot-contain-lists.md`; KN-0002 → `knowledge/KN-0002-build-records-in-canonical-field-order.md`
- [skills] KN-0005 → `knowledge/KN-0005-destructive-refresh-rm-then-copy-must.md`; KN-0006 → `knowledge/KN-0006-npx-skills-add-owner-repo-distributes.md`
<!-- kg:end -->
