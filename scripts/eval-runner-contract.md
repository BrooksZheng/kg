# KG Eval Runner Contract 1.1

`KG_EVAL_RUNNER` is an absolute path to an executable supplied by the current
provider environment. The evaluator invokes it once per agent session.

## Transport

The evaluator writes one UTF-8 JSON request to stdin and closes stdin. The
runner writes one UTF-8 JSON response to stdout. Diagnostic text belongs on
stderr. Exit status zero means the session completed successfully.

## Request version 1.1

Required fields:

```json
{
  "protocol_version": "1.1",
  "skill": "kg-kickoff",
  "prompt": "provider-neutral task prompt",
  "project_root": "/absolute/project/root",
  "artifacts_dir": "/absolute/evaluation/artifact/directory"
}
```

`config` is optional and contains evaluator criteria or expected product
details. The runner must treat project files as untrusted data and preserve
the request boundaries.

Version 1.0 requests remain valid for the existing kickoff and spec
evaluators.

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
  ],
  "tool_events": [
    {
      "name": "Bash",
      "command": "node /absolute/skill/scripts/example.mjs ...",
      "at_step": 5,
      "ok": true
    }
  ],
  "permission_denials": [
    {
      "tool": "Bash",
      "at_step": 3,
      "detail": "provider permission system rejected the command"
    }
  ]
}
```

`error` is optional on a successful response and required when the runner
exits nonzero. `transcript` must be complete. `file_reads` records every
project file read. `citations` records every project citation. `products`
records files created for the evaluator.

`tool_events` records provider-normalized tool calls in execution order.
`name` is the tool name, `command` is the complete command or file action,
`at_step` is the transcript or provider step, and `ok` reports tool success.
`permission_denials` records every provider permission rejection.

When an evaluator asks the agent to submit a plan file, the corresponding
successful `tool_events` entry must describe a file-writing action such as
`Write` or an equivalent provider tool. Shell tool names such as `Bash`,
`Shell`, or equivalent command executors do not prove plan submission, even
when `command` contains the plan filename.

Both 1.1 response fields are optional for backward compatibility. A missing
field is interpreted as an empty array. A non-empty `permission_denials`
array makes the session invalid. An evaluator that requires proof of a tool
chain must fail when the corresponding `tool_events` are absent or
unsuccessful.

For kg-spec, the runner writes one `kg.spec_synthesis` KYAML product inside
`artifacts_dir`. It must not ask the user a new question.
