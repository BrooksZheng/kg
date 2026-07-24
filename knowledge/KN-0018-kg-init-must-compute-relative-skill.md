---
id: KN-0018
claim: "kg-init must compute relative skill symlink targets from canonicalized source and parent paths so filesystem aliases such as /var and /private/var cannot create broken links."
category: project_knowledge
scope:
  paths:
    - skills/kg-init/scripts/install.mjs
    - scripts/test-rfc004.mjs
evidence:
  - { type: observation, ref: OBS-20260723-002 }
  - { type: test, ref: "node scripts/test-rfc004.mjs failed with ENOENT for the installed kg-scan link when the host used the /var alias" }
  - { type: test, ref: "the same test passed after both sides of path.relative were canonicalized" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-23
regret: null
---

## Detail

On macOS, a path reached through `/var` can resolve physically under
`/private/var`. Building a relative link from one lexical spelling and then
resolving it from the physical parent can point at a nonexistent location.

Before calling `path.relative`, canonicalize both the symlink parent directory
and the intended source with the installer's `canonical()` helper. Apply the
same rule to `.agents/skills/` and `.claude/skills/` wiring.

This complements KN-0005. That entry protects destructive copy identity
checks. This entry protects the target text of newly created relative
symlinks.
