---
kind: kg.project_document
doc_id: DOC-NOTIFICATION-BOUNDARY
type: decision
status: accepted
authority: formal_decision
---

# Notification boundary

Notification workers retry delivery through the queue and preserve the original idempotency key.

Workers must never write provider delivery state directly.

The credentials vault stays outside the notification worker DMZ.
