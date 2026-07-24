---
id: KN-0014
claim: "KG must allow humans and agents to directly draft and iterate complete ADR, RFC, and MVP design documents; the observation pipeline may learn from those artifacts but must not gate their creation."
category: project_contract
scope:
  paths:
    - "skills/kg-observe/**"
    - "skills/kg-init/**"
    - "skills/kg-compile/**"
    - "docs/**"
    - "protocol/**"
evidence:
  - { type: observation, ref: OBS-20260723-001 }
  - { type: quote, ref: "human: 在实际协作中，正常流程应该是我先跟它写完整篇文档，我看完了，大家再来回对抗讨论，最终形成一些 ADR。" }
  - { type: quote, ref: "docs/rfc-004-authoring-plane-and-brownfield-bootstrap.md §二 A1 and §四 (accepted 2026-07-24)" }
authority: user_explicit_constraint
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-24
regret: null
---

## Contract

KG governance must preserve a direct authoring lane for coherent collaboration
artifacts. Humans and agents may create and revise draft ADRs, RFCs, MVP
technical plans, and design documents in their normal project locations.
These artifacts can move through discussion and adversarial review before any
decision is final.

The observation pipeline can capture reusable signals from this work. A later
compile session can extract accepted decisions or project-specific lessons
into atomic knowledge entries and publish relevant constraints to agent
carriers. Drafting the source document does not require prior observation or
compilation.

## Boundary

Atomicity applies to `knowledge/*.md` ledger entries. It does not require
full project documents under `docs/**` to be decomposed into observations.
Generated or managed carriers remain governed by their existing render rules.
The registered project-document lifecycle and compiler eligibility rules live
in `protocol/project-document.schema.yaml` and RFC-004.

## Rejected behavior

Do not interpret `protocol/observation.schema.yaml` as the only permitted
input format for all project documentation. That interpretation blocks the
human review loop that ADRs and RFCs are meant to support.
