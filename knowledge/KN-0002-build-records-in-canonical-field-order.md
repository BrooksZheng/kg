---
id: KN-0002
claim: "Record scripts validate the RAW input first (rejecting unknown fields), then rebuild in canonical field order before writing; kyaml.stringify preserves insertion order."
category: project_knowledge
scope:
  paths: ["skills/*/scripts/*.mjs", scripts/lib/kyaml.mjs]
  domains: [protocol]
evidence:
  - { type: observation, ref: OBS-20260712-003 }
  - { type: observation, ref: OBS-20260712-007 }
  - { type: diff, ref: "commit 08c2a757d7: add-observation.mjs rebuilds the record in schema order after autofill" }
  - { type: diff, ref: "verifier round 1 nit 2: add-entry.mjs derives known fields from the schema and rejects unknown draft keys" }
authority: current_code_and_schema
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Detail

`kyaml.stringify` writes keys in JavaScript object insertion order. A script
that autofills missing fields by assignment (`record.id = ...`) appends them
to the END of the file, producing valid but ugly output (id/at after the
claim). Rebuild the record literal in canonical schema order just before
writing — see `add-observation.mjs` for the pattern.

Order matters on the way IN as well: validate the RAW record and reject
unknown fields BEFORE the whitelist rebuild. Rebuilding first silently drops
unknown keys, so a typo (`confidnce:`) surfaces as a misleading
"required field missing" error instead of naming the actual mistake.
