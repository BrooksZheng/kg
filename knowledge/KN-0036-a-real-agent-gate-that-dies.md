---
id: KN-0036
claim: "A real-agent gate that dies before its first tool call is an environment verdict, not a product verdict: attribute it to the runner adapter, leave the oracle untouched, do not retry in the same environment, and report the milestone as unclosed."
category: project_contract
scope:
  paths: ["scripts/eval-*.mjs", ".mission/**/tools/**"]
evidence:
  - { type: observation, ref: OBS-20260803-004 }
  - { type: observation, ref: OBS-20260803-011 }
  - { type: log, ref: "Six sessions across R3.3, R3.4, R4.2 and R4.4 died at provider ENOTFOUND with zero tool events, zero file reads and zero products; every one of them passed first try on a networked host with no oracle or product change (G-B3 246s, G-B4 210s, G-D1 318s, G-D2 245s)" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

Zero tool events is the discriminator, and it is machine-checkable. A
session that never issued a tool call never reached the product, so
nothing it did or failed to do is evidence about the product. The
temptation at that moment is to relax the gate — the run is red, the
deadline is now, and the oracle is the only thing within reach.

The correct handling has four parts, and dropping any one of them converts
an environment problem into permanent oracle damage:

1. Attribute to the runner adapter, not to agent, product, fixture, or
   evaluator.
2. Change nothing — no oracle, no fixture, no gate threshold.
3. Do not retry in the same environment; a second ENOTFOUND is not new
   information.
4. Report the milestone as unclosed and say why.

Six occurrences, six clean first-try passes elsewhere. The discipline has
never once cost a real defect a chance to surface.
