<!-- kg:begin -->
kg (Project Knowledge Growth) — managed block, rendered from `knowledge/`. Do not edit by hand.

- HARD RULE: never read `.kg/` during a work task — it holds uncompiled claims and pipeline state. Writes go only through the kg-observe skill; reads happen only inside kg-compile sessions.
- Record observations (task end, or IMMEDIATELY on human correction): `.agents/skills/kg-observe/SKILL.md`.
- Compile pending observations into knowledge: `.agents/skills/kg-compile/SKILL.md`.

Active project knowledge (read the entry before working in its scope):

- KN-0001 [project_knowledge] KYAML inline maps cannot contain lists; schema field specs encode enums as one pipe-separated string. → `knowledge/KN-0001-kyaml-inline-maps-cannot-contain-lists.md`
- KN-0002 [project_knowledge] Build records in canonical field order before writing; kyaml.stringify preserves insertion order. → `knowledge/KN-0002-build-records-in-canonical-field-order.md`
- KN-0003 [project_contract] Skill scripts must reach shared code only via the _lib.mjs resolver, and both install modes must preserve the lib/../../protocol layout. → `knowledge/KN-0003-skill-scripts-must-reach-shared-code.md`
<!-- kg:end -->
