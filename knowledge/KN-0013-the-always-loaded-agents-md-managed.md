---
id: KN-0013
claim: "The always-loaded AGENTS.md must stay a compact pointer entry with detail lazy-loaded on demand, because model instruction compliance degrades as the always-on instruction count grows — when the surface overflows, subtract entries rather than enlarge the surface."
category: project_knowledge
scope:
  paths:
    - "knowledge/**"
    - AGENTS.md
evidence:
  - { type: observation, ref: OBS-20260717-002 }
  - { type: quote, ref: "human-shared harness-engineering analysis (translated from Chinese): beyond roughly 150 instructions model compliance decays markedly; the ideal AGENTS.md is a pointer file of under 50 lines with detail loaded on demand into skills and subdirectory files" }
  - { type: quote, ref: ".mission/kg-v2-refactor/spec-revC.md §五: KN-0013 被取代 — v2 不再有托管段，agents_block_budget_lines 移除，精神由两阶段检索和 AGENTS.md 极简化（30 行内，含 Commands 段）承接" }
authority: external_general_knowledge
confidence: 0.6
lifecycle: active
supersedes: null
last_verified: 2026-08-03
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

v1 expressed this as a rendered managed block under a machine-enforced line
budget. v2 deleted the managed block and the budget knob
(`agents_block_budget_lines`); `render-agents.mjs` no longer exists. The
reasoning survives the mechanism, so the entry is rebound rather than
retired:

- AGENTS.md is a hand-kept minimal entry (target: within 30 lines, including
  the Commands section). It names hard rules and where to go, nothing more.
- Detail arrives through two-phase retrieval: `kg-kickoff` indexes the
  knowledge and document surface, then reads only what the task's scope
  actually touches.
- When the always-on surface grows past its target, the sanctioned response
  is still to SUBTRACT (merge / demote / retire), never to enlarge the
  surface. That rule is now prose rather than a gate — by KN-0012 it will
  therefore rot silently, so a size check belongs in `kg-scan`.
