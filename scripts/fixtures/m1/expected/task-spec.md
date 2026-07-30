---
kind: kg.task_spec
task_id: TASK-20260730-001
created_at: <generated>
status: draft
---

# Retry Payment event publication to Order

## Context

- Payment and Order communicate through an accepted event boundary.
- The requested retry must preserve Order deduplication.

## Requirements

1. Retry publication of the payment.authorized event after a transient failure.
2. Reuse the original idempotency key for every retry attempt.

## Constraints

| Constraint | Source | Source Status | Authority |
| --- | --- | --- | --- |
| Payment must not write the Order database directly. | docs/decisions/0001-payment-order-event-bus.md#L15 | accepted | formal_decision |
| Retries must preserve event deduplication. | docs/traps/payment-direct-write.md#L14 | accepted | formal_decision |

## References

- docs/architecture/overview.md
- src/payment/retry.mjs (planned implementation path)

## Out of Scope

1. Direct writes from Payment to the Order database.
2. Changing the event bus technology.

## Acceptance Criteria

1. GIVEN a transient publication failure WHEN Payment retries the event THEN every attempt uses the original idempotency key.
2. GIVEN duplicate delivery WHEN Order consumes the retried event THEN Order applies the state transition once.

## Open Questions

- The retry count and backoff policy remain to be selected during implementation planning.

## Session History

- kickoff session m1-kickoff-fixture-01
- Evidence selected from the accepted boundary decision and direct-write trap.
