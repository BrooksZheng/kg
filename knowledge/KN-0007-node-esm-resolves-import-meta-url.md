---
id: KN-0007
claim: "Node ESM resolves import.meta.url through symlinks, so argv[1]-vs-import.meta.url main-module checks must realpath argv[1] first — otherwise symlink-installed scripts silently skip their CLI entrypoint (exit 0, no output)."
category: project_knowledge
scope:
  paths: ["skills/*/scripts/**", scripts/lib/protocol.mjs]
evidence:
  - { type: observation, ref: OBS-20260713-003 }
  - { type: log, ref: "check-threshold.mjs via /tmp/host-sym symlink printed nothing, exit 0; realpathSync(argv[1]) fixed it (commit c009c4c)" }
  - { type: quote, ref: "scripts/lib/protocol.mjs isMain(): fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)" }
authority: verified_runtime_behavior
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-13
regret: null
---

## Detail

The common ESM main-module idiom compares `process.argv[1]` against
`import.meta.url`. Node resolves `import.meta.url` through symlinks (it is
the module's REAL path), but `argv[1]` stays whatever path the user invoked.
When a script is installed or aliased via symlink, the two never match, the
`if (isMain)` guard is false, and the script exits 0 having done nothing —
the worst failure mode, because nothing errors.

## The rule

Always canonicalize before comparing:

```js
fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
```

`scripts/lib/protocol.mjs` exposes this as the shared `isMain` check; new
skill scripts must use it instead of re-deriving the naive comparison.

## When this bites

Any install mode that reaches scripts through symlinks — e.g.
`.claude/skills/kg-*` symlink wiring, or a host root accessed via an alias.
Symptom signature: script "runs" with exit 0 and zero output.
