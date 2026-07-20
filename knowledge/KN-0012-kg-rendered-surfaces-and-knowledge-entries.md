---
id: KN-0012
claim: "kg rendered surfaces and knowledge entries should prefer pointer-form constraints (file paths, commands, entry links) over descriptive prose: pointer constraints fail loudly like a 404 when they rot, prose constraints rot silently — design for rot."
category: project_knowledge
scope:
  paths: ["knowledge/**", "skills/kg-compile/**"]
evidence:
  - { type: observation, ref: OBS-20260717-001 }
  - { type: quote, ref: "human-shared harness-engineering analysis (translated from Chinese): documentation-style constraints rot silently; pointer-style constraints (pointing at file paths, commands) report loudly like a 404 when they rot — deliberately choose the form that rots loudly" }
authority: external_general_knowledge
confidence: 0.6
lifecycle: active
supersedes: null
last_verified: 2026-07-19
regret: null
---

## Detail

Every constraint carrier eventually rots as the repo evolves. The failure
mode differs by form:

- **Descriptive prose** ("the build uses X", "always do Y") rots silently —
  nothing errors when the description stops being true, so agents keep
  obeying stale text.
- **Pointer-form constraints** (a file path, a command to run, a KN-entry
  link) rot loudly: the path 404s, the command fails, the link dangles. The
  rot itself becomes a signal that reaches the agent.

## Application in kg

When writing knowledge entries or shaping rendered surfaces, prefer encoding
detail as pointers to live artifacts (schema files, scripts, entry ids) over
restating their content in prose. This is already the render layer's index
philosophy (claim line + entry pointer); entry BODIES should follow the same
bias — cite `protocol/*.yaml` or a script path instead of paraphrasing them
at length.
