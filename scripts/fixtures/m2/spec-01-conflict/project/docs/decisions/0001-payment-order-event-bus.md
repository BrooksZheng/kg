---
kind: kg.project_document
title: "Payment to Order event boundary"
doc_type: decision
status: accepted
owners: [payments, orders]
accepted_at: 2026-07-28
supersedes: null
---

# Payment to Order event boundary

## Decision

Payment emits `payment.authorized`; Order consumes the event. Payment must not write the Order database directly.

## Retry constraint

Publication retries must reuse the same idempotency key so Order can discard duplicate delivery.
