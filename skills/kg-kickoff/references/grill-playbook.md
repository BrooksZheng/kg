# Grill Playbook

## Sequence

1. Read the metadata-only index and identify sources with an existing machine-verifiable basis.
2. If a source has only a semantic clue, ask one domain-confirmation question and stop.
3. After the human reply is present in the transcript, write the scope product.
4. Deep-read exactly the selected set.
5. Summarize relevant active constraints, draft references, and known traps with stable anchors.
6. Record every literal task-interpretation conflict as a task pointer plus constraint finding pair.
7. Choose the single clarification axis that most changes implementation scope.
8. Prepare options, one recommendation, and finding-based reason refs.
9. Use the recorder's exact assistant-message format and write one turn product.
10. Wait for the human reply before advancing the session.

## Domain confirmation

Index titles provide clues only. When a title suggests relevance and the task
does not contain an indexed path or domain, no graph or scope basis closes the
gap, ask this kind of question:

`Is the <indexed domain> domain part of this task？`

Do not write scope before the reply. A positive user reply becomes the
`human_confirmed_domain` transcript pointer. A negative reply leaves the
source outside scope.

## Question discipline

The question text contains exactly one `?` or `？`. Options contain no question
marks. The recommendation must equal one option. Every reason ref must name a
finding from the current deep exact set.

The script-rendered assistant message is the public question. Do not add a
prefix, suffix, Markdown styling, or quote substitution after rendering.

## Conflict discipline

Task silence is underspecification. Record a conflict only when at least one
literal reading of a user message violates a stable constraint. A
`no_conflict` product still cites the findings checked. An empty conflict
product with no reason refs is invalid.
