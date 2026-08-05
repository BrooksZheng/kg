# ADR candidate evidence

## CAND-QUEUE-OWNERSHIP
CAND-QUEUE-OWNERSHIP requires a durable data migration to reverse.
The queue ownership rationale depends on incident history that code cannot preserve.
Both service-owned and platform-owned queues are viable and trade operational control against consistency.

## CAND-REVERSIBLE
CAND-REVERSIBLE can be reversed by changing one configuration flag.
Its incident context remains outside code.
Two viable options carry a real operational tradeoff.

## CAND-CODE-CONTEXT
CAND-CODE-CONTEXT has material migration cost if reversed.
Code comments and configuration fully preserve why it was chosen.
Two viable options carry a real operational tradeoff.

## CAND-NO-TRADEOFF
CAND-NO-TRADEOFF has material migration cost if reversed.
Its incident context remains outside code.
Only one option is technically viable, so no genuine tradeoff exists.
