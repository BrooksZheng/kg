---
id: KN-0028
claim: "Agent-authored machine inputs must be strict JSON; KYAML and Markdown machine surfaces are produced only by validated writer scripts, never composed directly by an agent."
category: project_contract
scope:
  paths:
    - skills/kg-spec/scripts/produce-spec.mjs
    - skills/kg-kickoff/scripts/record-turn.mjs
    - skills/kg-compile/scripts/apply-compile-plan.mjs
    - skills/kg-compile/scripts/resolve-queue-item.mjs
    - scripts/lib/kyaml.mjs
evidence:
  - { type: observation, ref: OBS-20260730-003 }
  - { type: observation, ref: OBS-20260803-003 }
  - { type: test, ref: "2026-07-30 archived C10 replay: scripts/lib/kyaml.mjs line 96 rejected the original constraints list with multi-line list items are not supported after # values were quoted" }
  - { type: test, ref: "test-v2 Part 4 queue_resolution_writer_rejects_duplicate_and_double_ruling" }
  - { type: quote, ref: ".mission/kg-v2-refactor/contract-3.md §1.5.1: Agent 创作的机器输入使用严格 JSON。KYAML 与 Markdown 只由校验后的 writer 生成。" }
authority: formal_decision
confidence: 0.9
lifecycle: active
supersedes: null
last_verified: 2026-07-31
regret: null
source_obs_ids: [OBS-20260730-003]
carrier_refs: []
---

## Detail

KYAML is deliberately strict: inline maps cannot contain lists (KN-0001),
bare scalars cannot contain `#`, block-style mappings inside lists are
rejected. Agents composing KYAML by hand keep rediscovering these edges as
runtime failures. JSON has none of these traps and every runtime can emit
it exactly.

The binding division of labor across kg v2:

- Agents submit **strict JSON** (plans, syntheses, turn records, conflict
  records) through non-shell file-writing tools.
- **Writer scripts** validate the raw input, reject unknown fields, then
  render canonical KYAML/Markdown in canonical field order (KN-0002).
- Scripts own IDs, timestamps, hashes, sequence numbers, and paths.

Any new agent-facing interface must follow this contract rather than
accepting agent-composed KYAML or Markdown.

A machine surface with **no** writer script violates this contract just as
surely as one that is hand-edited, because the absence forces the editing.
Queue rulings had no writer, so recording a resolution meant appending
`resolution` and `resolution_note` to the ledger by hand — and the template
already carried `resolution_note: null`, so the first attempt produced a
duplicate key. The gap is closed by `resolve-queue-item.mjs`, which
replaces the placeholders and refuses a second ruling on an already
resolved item. When adding a ledger field, add its writer in the same
change.
