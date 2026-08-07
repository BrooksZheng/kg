---
id: KN-0033
claim: "A security boundary must be re-derived by the component that acts on it; a writer that trusts an upstream record's self-declared eligibility can be walked past the boundary by a hash-valid forged record."
category: project_contract
scope:
  paths:
    - skills/kg-docs/scripts/bootstrap.mjs
    - scripts/lib/repository.mjs
evidence:
  - { type: observation, ref: OBS-20260803-001 }
  - { type: test, ref: "test-v2 Part 2 kn0016_host_code_never_executes rejects a forged .env inventory record" }
  - { type: log, ref: "R3.3 D62: the inventory producer excluded secrets correctly, but bootstrap accepted any record the inventory contained, so a fabricated entry reintroduced an excluded host file" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-08-03
regret: null
source_obs_ids: [OBS-20260803-001]
carrier_refs: []
---

## Detail

KN-0016 binds the brownfield inventory boundary (no `.kg`, no secrets, no
binaries, no symlinks, no host execution). D62 showed that stating the rule
at the *producer* is not enough: the consumer received a structurally valid
inventory object and treated membership in it as proof of eligibility.
Hashes did not help — the forged record's hash was self-consistent, the
same self-referential trap the ledger layer bans elsewhere.

Binding rule for every writer that acts on an upstream inventory, manifest,
or allowlist: re-run the eligibility predicate against the real filesystem
before mutation. The upstream record supplies *candidates*; it never
supplies *authorization*. Cheap to run, and it converts a forged-record
attack into an ordinary rejection.
