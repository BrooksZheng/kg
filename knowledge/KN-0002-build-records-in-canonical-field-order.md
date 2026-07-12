---
id: KN-0002
claim: "Build records in canonical field order before writing; kyaml.stringify preserves insertion order."
category: project_knowledge
scope:
  paths: ["skills/*/scripts/*.mjs", scripts/lib/kyaml.mjs]
evidence:
  - { type: observation, ref: OBS-20260712-003 }
  - { type: diff, ref: "commit 08c2a757d7: add-observation.mjs rebuilds the record in schema order after autofill" }
authority: current_code_and_schema
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-12
regret: null
---

## Detail

`kyaml.stringify` writes keys in JavaScript object insertion order. A script
that autofills missing fields by assignment (`record.id = ...`) appends them
to the END of the file, producing valid but ugly output (id/at after the
claim). Rebuild the record literal in canonical schema order just before
writing — see `add-observation.mjs` for the pattern.
