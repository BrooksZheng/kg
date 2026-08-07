# ADR Criteria

A decision draft is eligible only when all three criteria are supported by
packet evidence and a human approves that candidate.

## hard_to_reverse

Reversing the decision has material cost or risk. Examples include data
migration, external compatibility commitments, security boundaries, and
operational ownership transfers. A flag flip or local refactor usually fails
this criterion.

## context_not_in_code

Code alone cannot safely preserve why the decision exists. Incident history,
rejected organizational boundaries, compliance rationale, and cross-system
constraints often qualify. A choice fully explained by code and configuration
fails this criterion.

## genuine_tradeoff

At least two options are technically viable and carry a real engineering
tradeoff. Each option must state its cost. A candidate with only one viable
option fails this criterion.

## Machine boundary

The assessment writer validates criterion IDs, conclusions, confidence,
packet-contained evidence refs, candidate identity, and structured human
approval. The agent judges the semantics. The script records that judgment as
`detection_mode: agent_assisted` and computes `eligible_for_draft`.
