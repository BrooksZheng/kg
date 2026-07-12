---
id: KN-0001
claim: "KYAML inline maps cannot contain lists; schema field specs encode enums as one pipe-separated string."
category: project_knowledge
scope:
  paths: ["protocol/**", scripts/lib/kyaml.mjs]
evidence:
  - { type: observation, ref: OBS-20260712-001 }
  - { type: quote, ref: "scripts/lib/kyaml.mjs splitItems() rejects nested inline collections by design" }
authority: current_code_and_schema
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-12
regret: null
---

## Detail

KYAML (the strict YAML subset all kg machine surfaces use) forbids nested
inline collections: `{ k: [a, b] }` is a parse error. Anywhere a schema field
spec needs a value list (enum members, for example), encode it as a single
pipe-separated string — `values: "a|b|c"` — and split on `|` in the consumer.

## When this bites

Writing or extending `protocol/*.yaml` field specs, or any new KYAML surface
that is tempted to nest a list inside an inline map. The parser will reject
the file; the fix is the pipe-string convention, not loosening the parser.
