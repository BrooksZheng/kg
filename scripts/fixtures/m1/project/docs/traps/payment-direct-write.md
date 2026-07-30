---
kind: kg.project_document
title: "Payment direct write trap"
doc_type: trap
status: accepted
accepted_at: 2026-07-29
supersedes: null
---

# Payment direct write trap

## Failure mode

Retrying a direct Order database write bypasses event deduplication and can produce duplicate state transitions.

## Safe path

Retry event publication with the original idempotency key.
