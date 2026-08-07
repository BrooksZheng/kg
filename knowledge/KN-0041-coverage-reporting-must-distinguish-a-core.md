---
id: KN-0041
claim: "Coverage reporting must distinguish a core type nobody has written yet from a registered document that fails a deterministic coverage condition, because collapsing them makes every young repository report a full set of gaps forever and readers stop reading the section."
category: project_knowledge
scope:
  paths:
    - skills/kg-scan/scripts/report-builder.mjs
    - protocol/document-taxonomy.yaml
evidence:
  - { type: observation, ref: OBS-20260804-003 }
  - { type: observation, ref: OBS-20260805-001 }
  - { type: test, ref: "test-v2 Part 7 scan_groups_coverage_by_taxonomy_derived_quadrant" }
  - { type: test, ref: "test-v2 Part 7 scan_excludes_spec_and_tutorials_from_coverage_denominator" }
  - { type: log, ref: "R4.4 verification on a host with no core documents: all eight gaps reported missing_core_type and none was miscoded uncovered_core_type" }
authority: verified_runtime_behavior
confidence: 0.85
lifecycle: active
supersedes: null
last_verified: 2026-08-05
regret: null
source_obs_ids: []
carrier_refs: []
---

## Detail

`missing_core_type` means no registered document claims this type.
`uncovered_core_type` means one exists but fails a deterministic condition
— draft status, superseded, or outside the expected location. The first is
youth and the second is drift, and they call for opposite responses: write
the document, versus find out what happened to the one you have.

The distinction only pays off if the finding says which condition failed.
`uncovered_core_type` alone tells a reader something is wrong without
telling them a draft is the reason, so each gap carries its
`unmet_conditions` and the offending document path — running scan against
this repository returns `architecture`, `api` and `glossary` as
`uncovered` with `unmet: [accepted_not_superseded]` and the three draft
paths, which is actionable, whereas the bare code would only prompt a
search. An issue code names a category; the reader needs the instance.

Both conditions are checkable without reading prose. Quadrants come from
`protocol/document-taxonomy.yaml` rather than a mapping in the report
builder, so adding a type does not require touching scan code. `spec` and
`tutorials` are excluded from the denominator — specs are per-task and
tutorials are optional, so counting them guarantees a permanent gap that
means nothing.

Semantic quality is out of scope here. Whether the document is any good is
an agent-assisted judgment, and it must not change a deterministic verdict.
