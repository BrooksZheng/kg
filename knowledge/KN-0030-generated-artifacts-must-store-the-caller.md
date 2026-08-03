---
id: KN-0030
claim: "Generated artifacts must store the caller's declared paths while comparing canonical paths, because canonicalized absolute paths bake the generating machine into the output and make saved fixtures unreplayable elsewhere."
category: project_knowledge
scope:
  paths:
    - skills/kg-kickoff/scripts/gather-context.mjs
    - "scripts/eval-*.mjs"
    - "scripts/fixtures/**"
evidence:
  - { type: observation, ref: OBS-20260731-019 }
  - { type: test, ref: "test-v2 Part 2 live_and_check_modes_share_canonical_path_semantics" }
  - { type: log, ref: "R3.1 D56: regenerating kickoff oracles through the public CLI wrote developer-machine absolute paths into spec-03 saved context until the writer preserved the declared root" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-03
regret: null
source_obs_ids: [OBS-20260731-019]
carrier_refs: []
---

## Detail

Canonicalization has two separate jobs and they pull in opposite directions:

- **Comparison** (identity, containment) must canonicalize both sides —
  see KN-0022. A lexical compare across `/tmp` and `/private/tmp` is wrong.
- **Storage** must keep the declared form. A saved product that records
  `/Users/<someone>/work/repo/docs/x.md` is only replayable on that
  machine; the same product recording `docs/x.md` replays anywhere.

So a writer canonicalizes internally to decide, then emits the declared
(usually project-relative) spelling. Any script that generates a saved
fixture, oracle, index, or context file falls under this rule.
