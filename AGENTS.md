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
