---
id: KN-0039
claim: "A scan that gates on every anomaly is unusable on a real repository; findings must be tiered so that hard errors gate while records that are merely legacy-shaped or young warn without failing the build."
category: project_knowledge
scope:
  paths:
    - "skills/kg-scan/scripts/**"
    - protocol/scan.yaml
    - protocol/scan-report.schema.yaml
evidence:
  - { type: observation, ref: OBS-20260804-001 }
  - { type: test, ref: "test-v2 Part 7 scan_gate_fails_on_hard_errors_but_reports_coverage_gaps" }
  - { type: test, ref: "test-v2 Part 7 scan_covers_all_ownerships_and_reports_resident_surface_warning" }
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

Three classes of finding, three severities. A dangling reference, a hash
mismatch, or a source line outside its file is an error and gates: the
graph is provably wrong. A v1 record with no trace on either side warns:
it is migration residue, not corruption, and gating on it would make every
partially migrated host permanently red. Coverage gaps and the
`AGENTS.md` line budget warn: they are the health signal the scan exists
to produce, and a repository legitimately sits with gaps for months.

The failure mode of getting this wrong is not a false alarm — it is that
readers learn to ignore the report. A scan whose exit code is always
non-zero conveys nothing, and the errors that do matter arrive in the same
noise as the ones that never did.
