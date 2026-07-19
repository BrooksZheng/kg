---
id: KN-0011
claim: "Karpathy's llm-wiki (gist, 2026) is the closest prior art to kg's compiler mental model; kg differs on input stream (work-process signals vs external documents), consumption (publish-as-injection vs query), record unit (atomic claim with evidence/authority vs topic page), trust model (governed untrusted compiler vs trusted librarian), and knowledge endpoint (prose graduates into machine constraints vs stays prose)."
category: project_knowledge
scope:
  paths: [docs/rfc-001-project-knowledge-growth-protocol.md]
evidence:
  - { type: observation, ref: OBS-20260713-016 }
  - { type: quote, ref: "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f — 'The human's job is to curate sources, direct the analysis, ask good questions... The LLM's job is everything else' (trusted-librarian stance)" }
  - { type: quote, ref: "human: 嗯啊，记下来吧 — endorsing the comparison conclusion for the next compile round" }
authority: agent_inference
confidence: 0.75
lifecycle: active
supersedes: null
last_verified: 2026-07-19
regret: null
---

## Detail

Karpathy's llm-wiki pattern (a personal wiki whose pages are compiled by an
LLM from curated sources) shares kg's central mental model — an LLM acting as
a knowledge COMPILER rather than a retrieval engine — which makes it the
closest prior art found in the RFC-001 section-8 competitive scan. The
differences are structural, not cosmetic:

| dimension | llm-wiki | kg |
| --- | --- | --- |
| input stream | external documents the human curates | work-process signals (corrections, task outcomes, test failures) |
| consumption | human queries/reads the wiki | publish-as-injection into native carriers (AGENTS.md index, rules) |
| record unit | topic page | atomic claim with evidence + authority + lifecycle |
| trust model | trusted librarian ("the LLM's job is everything else") | governed untrusted compiler (no_change legality, forced conflict queue, mandatory subtraction, regret) |
| knowledge endpoint | stays prose | prose graduates into machine constraints (tests/lint/CI) |

## Why the record-unit difference matters

llm-wiki's topic-page unit is exactly the storage-layer aggregation rejected
in RFC-002 R1 (see KN-0009): correct for reading notes, wrong for
behavior-binding engineering knowledge, where lifecycle/evidence/regret must
attach at claim precision.
