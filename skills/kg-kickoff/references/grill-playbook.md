# Grill Playbook

## Purpose

Turn retrieved project evidence into the smallest useful clarification
sequence. Preserve human decision authority and avoid questions whose answers
already exist in the repository.

## Sequence

1. Summarize the relevant area, accepted constraints, draft references, and
   known traps with citations.
2. Name each requirement conflict explicitly.
3. Choose the single clarification that most changes implementation scope.
4. Ask only that question. Include one recommended answer and one evidence
   based reason.
5. Wait for the answer before advancing to another question.
6. Finish with confirmed scope, conflicts resolved or pending, citations, and
   budget truncation.

## Question discipline

Count both `?` and `？` as question marks. One assistant turn may contain at
most one. A recommendation without a reason is incomplete. A reason without a
project citation is weak.

Use this Chinese response template:

`你要把重试放在 A 还是 B？我推荐 B。理由：<文档锚点> 已确认 <约束>，B 能保持该边界。`

## M1 boundary

Do not edit project documentation. Do not publish knowledge or harness
artifacts. Do not create a task spec. Those behaviors are evaluated in later
milestones.
