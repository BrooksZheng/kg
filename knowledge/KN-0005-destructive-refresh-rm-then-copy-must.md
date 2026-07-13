---
id: KN-0005
claim: "Destructive refresh (rm-then-copy) must first prove src and dest differ by canonical identity — fs.realpathSync with a resolve fallback for not-yet-existing paths; vendored re-runs and symlink aliases both collapse src==dest."
category: project_knowledge
scope:
  paths: [skills/kg-init/scripts/install.mjs]
  domains: [skills]
evidence:
  - { type: observation, ref: OBS-20260712-006 }
  - { type: observation, ref: OBS-20260712-008 }
  - { type: log, ref: "/tmp/kg-copy-test2 and /tmp/kg-rp-alias drills: vendored and alias re-runs skip instead of deleting the source" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Detail

Two ways the same directory shows up as both `src` and `dest` of a skill
refresh:

1. **Vendored re-run** — running the installer from inside a `--copy` host
   resolves `PLUGIN_ROOT` into the host's own `.agents` tree.
2. **Symlink alias** — the host root reached via a symlink alias defeats a
   lexical `path.resolve` comparison; only `fs.realpathSync` (falling back to
   `path.resolve` for paths that do not exist yet) proves identity.

Either way, an unguarded `rmSync(dest)` before `cpSync(src, ...)` deletes the
source itself. Guard at two layers: skip identical src/dest in the wiring
loop (log and continue), and hard-fail inside the copy helper as a backstop
BEFORE any `rmSync`.
