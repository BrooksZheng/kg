---
id: KN-0006
claim: "npx skills add owner/repo distributes the repo's DEFAULT branch only; unmerged branch fixes never reach consumers, and branch URLs whose branch name contains a slash fail the CLI's parsing — test unmerged branches from a local clone."
category: project_knowledge
scope:
  paths: ["skills/**", README.md]
  domains: [skills]
evidence:
  - { type: observation, ref: OBS-20260713-004 }
  - { type: quote, ref: "human 2026-07-13: 执行命令还提示了错误 kg: error: cannot locate shared lib — real-world npx skills add pulled main, which predates the vendored copies" }
  - { type: log, ref: "npx skills add .../tree/cursor/skills-add-support-0cf1 -> fatal: Remote branch cursor not found (CLI splits the ref at the first slash)" }
authority: verified_runtime_behavior
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-13
regret: null
---

## What happened

The self-contained skill-dir layout was implemented and verified on a feature
branch, and the work was declared done — but the consumer's real install
(`npx skills add BrooksZheng/kg`) pulled the **default branch**, which did not
have the fix yet, and failed with `cannot locate shared lib`.

## The rule

- `npx skills add owner/repo` (and `skills update`) resolve the repo's
  default branch. Anything meant for consumers is NOT shipped until it lands
  on that branch. "Verified locally on the branch" is not "released".
- Branch-qualified GitHub tree URLs only work when the branch name has no
  slash: the CLI splits the ref at the first `/` (so `cursor/foo` becomes
  branch `cursor`). URL-encoding `%2F` does not help.
- To test an unmerged branch as a consumer would:

  ```bash
  git clone -b <branch> <repo-url> /tmp/kg && npx skills add /tmp/kg
  ```

## Consequence for this repo

Any change to `skills/**` (including the vendored `scripts/lib/` +
`protocol/` copies) is consumer-visible only after merge to the default
branch. Release verification must include one install from the default
branch, not just from the working tree.
