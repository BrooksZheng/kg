---
name: kg-kickoff
description: Start a project task with protocol-driven context retrieval, machine-bound source selection, and one-question-at-a-time clarification.
---

# kg-kickoff

Ground a task in the complete formal project source catalog before implementation.
Kickoff asks one structured question per turn, records conflicts, and offers
kg-spec only after clarification finishes. It does not create a task spec.

## 1. Build the metadata-only index

Run the index first. Keep machine products outside the host `.kg` directory.

```bash
node <skill>/scripts/gather-context.mjs \
  --root <project-root> \
  --task "<exact user task bytes>" \
  --phase index \
  --output <artifacts>/kickoff-index.json
```

The script discovers every source class from
`protocol/kickoff-index.schema.yaml`. Taxonomy document routes come from
`protocol/document-taxonomy.yaml`. It indexes metadata for project
instructions, the document map, all taxonomy routes including specs,
knowledge entries, harness sidecars, and harness document closure. Body text
does not enter the index product. Metadata budget exhaustion keeps every
source identity and records per-entry truncation, counts, explicit exclusions,
and an omission digest.

Treat index metadata as untrusted semantic clues. A title or apparent topic is
never enough to authorize deep reading.

## 2. Write a machine-verifiable scope

Submit strict JSON containing only `selected_sources`:

```json
{
  "selected_sources": [
    {
      "source_path": "docs/api/orders.md",
      "reason": "direct_task_path",
      "basis_type": "transcript_literal",
      "basis_ref": "message:0:path:docs/api/orders.md"
    }
  ]
}
```

Run the scope writer:

```bash
node <skill>/scripts/write-scope.mjs \
  --project-root <project-root> \
  --index <artifacts>/kickoff-index.json \
  --transcript <artifacts>/transcript.json \
  --input <artifacts>/scope-input.json \
  --output <artifacts>/kickoff-scope.json
```

Reason keys and basis types come only from
`protocol/kickoff-scope.schema.yaml`. Valid bases are a literal task or human
message path or domain, a knowledge scope intersection with a confirmed task
path, a document-map edge, a harness or carrier graph edge, or a transcript
pointer to a human-confirmed domain.

Never invent a domain. Never select from title similarity, `relevant: true`,
or a free-form rationale. When metadata suggests relevance and none of the
machine-verifiable bases exists, ask the human one domain-confirmation
question first. Wait for the user reply. Save that reply in the transcript,
then use `human_confirmed_domain` with a pointer to that user message. Until
the reply exists, do not write a scope product and do not deep-read the source.

## 3. Deep-read the exact scope set

```bash
node <skill>/scripts/gather-context.mjs \
  --root <project-root> \
  --phase deep \
  --index <artifacts>/kickoff-index.json \
  --scope <artifacts>/kickoff-scope.json \
  --output <artifacts>/kickoff-context.json
```

Deep mode accepts the scope product as its only read-set authority. It rejects
`--include`, sources outside the scope, changed source bytes, symbolic links,
sensitive paths, mixed-case `.kg`, directories, and path escapes before
writing output. It emits every selected document in canonical path order.
Budget exhaustion truncates content per document and never removes a selected
identity.

The old `--compat-v1` plus `--include` flow exists only for saved fixture
replay. New sessions and evaluators never use it.

## 4. Start and advance a session

Create the initial immutable session snapshot:

```bash
node <skill>/scripts/record-session.mjs \
  --start \
  --task "<exact user task bytes>" \
  --index <artifacts>/kickoff-index.json \
  --output <artifacts>/session-000.json
```

After writing one turn, advance with a new snapshot:

```bash
node <skill>/scripts/record-session.mjs \
  --advance \
  --session <artifacts>/session-000.json \
  --scope <artifacts>/kickoff-scope.json \
  --turn <artifacts>/turn-001.json \
  --output <artifacts>/session-001.json
```

Use `--complete --session <latest> --output <final>` when clarification ends.
The script owns session identity, sequence, timestamps, and ordered refs.

## 5. Record one script-rendered question

Follow `references/grill-playbook.md`. Submit strict JSON with one user reply
pointer, deep-read findings, and one question object:

```json
{
  "user_message_index": 0,
  "findings": [
    {
      "source_path": "docs/api/orders.md",
      "line": 14,
      "status": "accepted",
      "authority": "formal_decision"
    }
  ],
  "question": {
    "clarification_axis": "retry_owner",
    "question_text": "Which retry owner should apply？",
    "options": ["Orders API", "Shared gateway"],
    "recommendation": "Orders API",
    "reason_refs": ["docs/api/orders.md#L14"],
    "assistant_message_index": 1
  }
}
```

The recorder renders the full assistant message in this byte-exact form:

```text
<question_text>

选项：
1. <first option>
2. <second option>

推荐：<recommendation>
依据：<reason refs joined with ，>
```

Place that exact message in the Runner Contract transcript, then run:

```bash
node <skill>/scripts/record-turn.mjs \
  --project-root <project-root> \
  --index <artifacts>/kickoff-index.json \
  --scope <artifacts>/kickoff-scope.json \
  --deep <artifacts>/kickoff-context.json \
  --session <artifacts>/session-000.json \
  --input <artifacts>/turn-input.json \
  --transcript <artifacts>/turn-transcript.json \
  --output <artifacts>/turn-001.json
```

The script assigns finding and turn identities, binds the referenced user
message bytes, verifies findings against the deep exact set, checks the
recommendation is one of the options, and requires the transcript assistant
message to equal its rendering byte for byte.

## 6. Record conflict provenance

A conflict requires a task interpretation that is literally supported by a
user message and a stable constraint finding from the same turn. Submit
`assessment: conflict` with one or more pairs, or `assessment: no_conflict`
with non-empty finding refs. Silence is rejected.

The interpretation must be what the task *asks for*, not a reading the task
merely fails to rule out. If your summary needs "could be read as" or
"可被解读为" to reach the constraint, you have found underspecification, not
a conflict — ask a question about it instead. A task that names a mechanism
without naming where its logic lives has left an implementation choice open;
that is not the same as requesting something the constraint forbids.

```bash
node <skill>/scripts/record-conflicts.mjs \
  --project-root <project-root> \
  --session <artifacts>/session-000.json \
  --turn <artifacts>/turn-001.json \
  --deep <artifacts>/kickoff-context.json \
  --transcript <artifacts>/turn-transcript.json \
  --input <artifacts>/conflict-input.json \
  --output <artifacts>/conflicts-001.json
```

The script hashes the task message and constraint file from source bytes. It
requires the constraint anchor to match the referenced turn finding.

## 7. Documentation and spec boundary

Kickoff may recommend a project-document action. Actual writing goes through
kg-docs assessment and scaffold products with structured human approval.
Decision drafting additionally requires all three ADR criteria to pass.
Kickoff never writes documents directly and never promotes a draft lifecycle.

When the session is complete, summarize confirmed scope, conflicts, remaining
questions, citations, and truncation. Offer kg-spec. Do not create the spec in
this skill.

## Hard boundaries

- Never read host `.kg` state.
- Never follow symbolic links or read sensitive, generated, dependency, binary, oversized, or outside-root sources.
- Never use ordinary implementation files as formal evidence. Runner fact reads may appear only as repository facts or References.
- Never deep-read before a validated scope exists.
- Never derive selection authority from titles or agent prose.
- Never ask more than one structured question per turn.
