---
id: KN-0019
claim: "SKILL.md frontmatter description values containing colon-space must be quoted; otherwise npx skills add fails YAML parsing and silently skips the skill."
category: project_knowledge
scope:
  paths: ["skills/*/SKILL.md", ".agents/skills/*/SKILL.md"]
evidence:
  - { type: observation, ref: OBS-20260724-001 }
  - { type: log, ref: "npx skills add brookszheng/kg --list: Skipped kg-init/SKILL.md — Nested mappings are not allowed in compact mappings at line 2, column 14; Found 3 skills" }
  - { type: diff, ref: "skills/kg-init/SKILL.md quoted the description containing MANUAL INVOCATION ONLY:" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260724-001]
carrier_refs: []
---

## Detail

The skills registry CLI parses SKILL.md frontmatter as YAML. An unquoted
`description:` value that itself contains `: ` (colon-space) is read as a
nested mapping, the parse fails, and the CLI **silently skips** the skill —
the repo appears to publish fewer skills with no error.

Rule: always quote `description` (and any frontmatter scalar) that contains
colon-space, `#`, or leading/trailing whitespace. Verify with
`npx skills add <owner>/<repo> --list` after editing frontmatter.
