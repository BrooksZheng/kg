---
id: KN-0013
claim: "The always-loaded AGENTS.md managed block must stay a compact pointer index with detail lazy-loaded from knowledge/ entries, because model instruction compliance degrades as the always-on instruction count grows — this is the external rationale behind the render-layer line budget and its do-not-raise-the-budget rule."
category: project_knowledge
scope:
  paths:
    - "knowledge/**"
    - skills/kg-compile/scripts/render-agents.mjs
evidence:
  - { type: observation, ref: OBS-20260717-002 }
  - { type: quote, ref: "human-shared harness-engineering analysis (translated from Chinese): beyond roughly 150 instructions model compliance decays markedly; the ideal AGENTS.md is a pointer file of under 50 lines with detail loaded on demand into skills and subdirectory files" }
authority: external_general_knowledge
confidence: 0.6
lifecycle: active
supersedes: null
last_verified: 2026-07-19
regret: null
---

## Detail

The AGENTS.md managed block is ALWAYS in context, so every line it holds
competes for attention with the actual task. Community evidence (2026)
converges on the same shape kg's render layer enforces: instruction
compliance decays markedly as the always-on instruction count grows (the
figure cited is roughly 150 instructions), and the ideal top-level file is a
pointer index with detail loaded on demand.

## Application in kg

This is the external rationale for two existing mechanisms — it explains WHY
they must not be weakened:

- `render-agents.mjs` enforces a line budget on the managed block; a budget
  failure is the context-bloat alarm and the sanctioned response is to
  SUBTRACT entries (merge/demote/retire), never to raise the budget.
- The index renders one claim line + one entry pointer per active entry;
  entry bodies stay in `knowledge/` and are read on demand when an agent
  enters the entry's scope.
