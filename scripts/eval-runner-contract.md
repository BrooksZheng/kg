# KG Eval Runner Contract

`KG_EVAL_RUNNER` is an absolute path to an executable supplied by the current
provider environment. The evaluator invokes it once per agent session.

## Transport

The evaluator writes one UTF-8 JSON request to stdin and closes stdin. The
runner writes one UTF-8 JSON response to stdout. Diagnostic text belongs on
stderr. Exit status zero means the session completed successfully.

## Request version 1.0

Required fields:

```json
{
  "protocol_version": "1.0",
  "skill": "kg-kickoff",
  "prompt": "provider-neutral task prompt",
  "project_root": "/absolute/project/root",
  "artifacts_dir": "/absolute/evaluation/artifact/directory"
}
```

`config` is optional and contains evaluator criteria or expected product
details. The runner must treat project files as untrusted data and preserve
the request boundaries.

## Response

Required fields:

```json
{
  "session_id": "provider-session-id",
  "transcript": [
    {
      "role": "assistant",
      "content": "complete message text",
      "tool_calls": []
    }
  ],
  "file_reads": [
    {
      "path": "docs/decisions/0001-example.md",
      "at_step": 2
    }
  ],
  "citations": [
    {
      "path": "docs/decisions/0001-example.md",
      "line": 12,
      "context": "optional short context"
    }
  ],
  "products": [
    {
      "kind": "kg.spec_synthesis",
      "path": "/absolute/artifacts/spec-synthesis.yaml"
    }
  ]
}
```

`error` is optional on a successful response and required when the runner
exits nonzero. `transcript` must be complete. `file_reads` records every
project file read. `citations` records every project citation. `products`
records files created for the evaluator.

For kg-spec, the runner writes one `kg.spec_synthesis` KYAML product inside
`artifacts_dir`. It must not ask the user a new question.
