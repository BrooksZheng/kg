---
id: KN-0001
claim: "Payment communicates with Order through the accepted event boundary."
category: project_contract
scope:
  paths: [services/payment/**, services/order/**]
evidence:
  - { type: quote, ref: "docs/decisions/0001-payment-order-event-bus.md Decision" }
authority: formal_decision
confidence: 0.95
lifecycle: active
supersedes: null
last_verified: 2026-07-29
regret: null
---

# Payment boundary

Use the accepted decision as the stable source.
