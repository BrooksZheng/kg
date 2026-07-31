#!/usr/bin/env node

// Deterministic Runner Contract 1.1 fixture for C9 evaluator regressions.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "../../lib/kyaml.mjs";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const skill = path.join(request.project_root, ".agents", "skills", "kg-kickoff");
const gatherScript = path.join(skill, "scripts", "gather-context.mjs");
const turnScript = path.join(skill, "scripts", "record-turn.mjs");
const conflictScript = path.join(skill, "scripts", "record-conflicts.mjs");
const indexFile = path.join(request.artifacts_dir, "kickoff-index.json");
const contextFile = path.join(request.artifacts_dir, "kickoff-context.json");
const turnInputFile = path.join(request.artifacts_dir, "kickoff-turn-input.json");
const turnTranscriptFile = path.join(request.artifacts_dir, "kickoff-turn-transcript.json");
const turnFile = path.join(request.artifacts_dir, "kickoff-turn.yaml");
const conflictInputFile = path.join(request.artifacts_dir, "kickoff-conflicts-input.json");
const conflictFile = path.join(request.artifacts_dir, "kickoff-conflicts.yaml");
const fixedNow = "2026-07-31T04:00:00Z";

function command(script, args) {
  return [process.execPath, script, ...args].map((value) => JSON.stringify(value)).join(" ");
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: request.project_root,
    env: { ...process.env, KG_ROOT: request.project_root },
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || "fixture command failed");
    process.exit(result.status || 1);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalCase() {
  const thirdKn = "knowledge/KN-0002-compile-managed-runbooks-must-preserve-human.md";
  if (fs.existsSync(path.join(request.project_root, ...thirdKn.split("/")))) return "compiled";
  if (request.prompt.includes("通过事件总线")) return "no_conflict";
  return "conflict";
}

const caseName = normalCase();
const cases = {
  conflict: {
    task: "为 Payment 到 Order 的写入增加重试",
    findings: [
      {
        source_path: "docs/decisions/0001-payment-order-event-bus.md",
        line: 15,
        status: "accepted",
        authority: "formal_decision",
      },
      {
        source_path: "docs/traps/payment-direct-write.md",
        line: 14,
        status: "accepted",
        authority: "formal_decision",
      },
    ],
    question: "你希望把重试目标限定为事件发布，还是继续尝试直接写 Order 数据库？",
    assistant:
      "已读取事件边界与直接写入陷阱。你希望把重试目标限定为事件发布，还是继续尝试直接写 Order 数据库？" +
      "我推荐限定为事件发布。理由：已接受决策要求复用同一幂等键并禁止 Payment 直接写 Order 数据库。",
    conflicts: [
      {
        summary: "任务中的写入若指直接写 Order 数据库，与已接受决策冲突",
        source_path: "docs/decisions/0001-payment-order-event-bus.md",
        line: 15,
      },
    ],
    distractor: {
      source_path: "docs/unrelated/marketing.md",
      line: 1,
      status: "unregistered",
      authority: "reference_only",
    },
  },
  no_conflict: {
    task: "通过事件总线为 payment.authorized 发布增加重试机制",
    findings: [
      {
        source_path: "docs/decisions/0001-payment-order-event-bus.md",
        line: 19,
        status: "accepted",
        authority: "formal_decision",
      },
    ],
    question: "你希望先确定退避策略，还是先确定重试次数？",
    assistant:
      "任务已经明确使用事件总线，符合已接受边界。你希望先确定退避策略，还是先确定重试次数？" +
      "我推荐先确定退避策略。理由：退避时间会先界定复用同一幂等键的重试窗口。",
    conflicts: [],
    distractor: {
      source_path: "docs/unrelated/marketing.md",
      line: 1,
      status: "unregistered",
      authority: "reference_only",
    },
  },
  compiled: {
    task: "让 compile 通过路径别名或产物 symlink 更新整个 runbook",
    findings: [
      {
        source_path: "knowledge/KN-0002-compile-managed-runbooks-must-preserve-human.md",
        line: 3,
        status: "active",
        authority: "verified_runtime_behavior",
      },
      {
        source_path: "docs/runbooks/compile-notes.md",
        line: 7,
        status: "unregistered",
        authority: "reference_only",
      },
      {
        source_path: "docs/accepted-compile-contract.md",
        line: 14,
        status: "accepted",
        authority: "formal_decision",
      },
    ],
    question: "你希望保留路径别名方案，还是改为只更新真实路径下的 managed block？",
    assistant:
      "active KN 与 managed carrier 都要求保留 marker 外的人类文本。" +
      "你希望保留路径别名方案，还是改为只更新真实路径下的 managed block？" +
      "我推荐只更新真实路径下的 managed block。理由：该路径同时满足 KN 约束和 carrier 的自动更新边界。",
    conflicts: [
      {
        summary: "更新整个 runbook 会改写 managed block 外的人类文本",
        source_path: "knowledge/KN-0002-compile-managed-runbooks-must-preserve-human.md",
        line: 3,
      },
    ],
    // D47: the fixture's remaining oracle distractor. KN-0001 was removed
    // from the distractor list because its path sits inside the task's
    // topical neighborhood.
    distractor: {
      source_path: "docs/traps/legacy-cache-key.md",
      line: 10,
      status: "accepted",
      authority: "formal_decision",
    },
  },
};
const selected = cases[caseName];

const indexArgs = [
  "--root",
  request.project_root,
  "--task",
  selected.task,
  "--phase",
  "index",
  "--output",
  indexFile,
];
run(gatherScript, indexArgs);

let findings = selected.findings.map((finding) => ({ ...finding }));
let includes = selected.findings.map((finding) => finding.source_path);
if (caseName === "compiled" && process.env.KG_FAKE_SINGLE_SOURCE === "kn") {
  findings = findings.filter((finding) => finding.source_path.startsWith("knowledge/"));
  includes = findings.map((finding) => finding.source_path);
}
if (caseName === "compiled" && process.env.KG_FAKE_SINGLE_SOURCE === "carrier") {
  findings = findings.filter(
    (finding) => finding.source_path === "docs/runbooks/compile-notes.md",
  );
  includes = findings.map((finding) => finding.source_path);
}
if (process.env.KG_FAKE_PROSE_ONLY === "1") {
  findings = findings.slice(1);
}
if (process.env.KG_FAKE_READ_DISTRACTOR === "1") {
  includes.push(selected.distractor.source_path);
}

const deepArgs = [
  "--root",
  request.project_root,
  "--phase",
  "deep",
  "--index",
  indexFile,
  ...includes.flatMap((sourcePath) => ["--include", sourcePath]),
  "--output",
  contextFile,
];
run(gatherScript, deepArgs);

const transcript = [
  { role: "user", content: selected.task },
  { role: "assistant", content: selected.assistant, tool_calls: [] },
];
writeJson(turnTranscriptFile, { transcript });
writeJson(turnInputFile, {
  findings,
  question: {
    question_text: selected.question,
    assistant_message_index: 1,
  },
});
const turnArgs = [
  "--project-root",
  request.project_root,
  "--index",
  indexFile,
  "--input",
  turnInputFile,
  "--transcript",
  turnTranscriptFile,
  "--output",
  turnFile,
  "--now",
  fixedNow,
];
run(turnScript, turnArgs);
if (process.env.KG_FAKE_UNREAD_REASON === "1") {
  const turn = parse(fs.readFileSync(turnFile, "utf8"));
  turn.findings.push({ ...selected.distractor });
  fs.writeFileSync(turnFile, stringify(turn));
  findings.push({ ...selected.distractor });
}

let conflicts = selected.conflicts.map((conflict) => ({ ...conflict }));
if (process.env.KG_FAKE_CONFLICT_NOT_COVERED === "1" && conflicts.length > 0) {
  conflicts.push({
    summary: "fixture conflict source is outside turn findings",
    source_path: selected.distractor.source_path,
    line: selected.distractor.line,
  });
}
if (process.env.KG_FAKE_NONEMPTY_CONFLICT === "1" && conflicts.length === 0) {
  conflicts.push({
    summary: "fixture injected unexpected conflict",
    source_path: "docs/decisions/0001-payment-order-event-bus.md",
    line: 15,
  });
}
let conflictArgs = null;
if (conflicts.length > 0) {
  writeJson(conflictInputFile, {
    kind: "kg.kickoff_conflicts",
    version: 1,
    conflicts,
  });
  conflictArgs = [
    "--project-root",
    request.project_root,
    "--input",
    conflictInputFile,
    "--output",
    conflictFile,
  ];
  run(conflictScript, conflictArgs);
}

const badIndex = process.env.KG_FAKE_BAD_QUESTION_INDEX;
let responseTranscript = transcript;
if (badIndex) {
  const turn = parse(fs.readFileSync(turnFile, "utf8"));
  if (badIndex === "analysis" || badIndex === "tool") {
    responseTranscript = [
      transcript[0],
      { role: badIndex, content: selected.assistant },
      transcript[1],
    ];
    turn.question.assistant_message_index = 1;
  } else if (badIndex === "out_of_range") {
    turn.question.assistant_message_index = 99;
  }
  fs.writeFileSync(turnFile, stringify(turn));
}

const toolEvents = [
  ...(process.env.KG_FAKE_FAILED_EXPLORATION === "1"
    ? [
        {
          name: "Read",
          command: path.join(request.project_root, "docs", "missing-exploration.md"),
          at_step: 0,
          ok: false,
        },
      ]
    : []),
  { name: "Bash", command: command(gatherScript, indexArgs), at_step: 1, ok: true },
  { name: "Bash", command: command(gatherScript, deepArgs), at_step: 2, ok: true },
  // D48 regression: the conflict recorder may legitimately run after the
  // turn recorder — only "after deep" is an integrity invariant.
  ...(conflictArgs
    ? [
        {
          name: "Bash",
          command: command(conflictScript, conflictArgs),
          at_step: process.env.KG_FAKE_LATE_CONFLICT === "1" ? 5 : 3,
          ok: true,
        },
      ]
    : []),
  { name: "Bash", command: command(turnScript, turnArgs), at_step: 4, ok: true },
];
const readStep = process.env.KG_FAKE_EARLY_READ === "1" ? 0 : 2;
const fileReads = includes.map((sourcePath) => ({ path: sourcePath, at_step: readStep }));

const products = [
  { kind: "kg.kickoff_context_index", path: indexFile },
  { kind: "kg.kickoff_context", path: contextFile },
  { kind: "kg.kickoff_turn", path: turnFile },
  ...(conflicts.length > 0 ? [{ kind: "kg.kickoff_conflicts", path: conflictFile }] : []),
];
const response = {
  session_id: `fixture-kickoff-${caseName}`,
  transcript: responseTranscript,
  file_reads: fileReads,
  citations: findings.map((finding) => ({
    path: finding.source_path,
    line: finding.line,
  })),
  products,
  tool_events: toolEvents,
  permission_denials:
    process.env.KG_FAKE_DENIAL === "1"
      ? [{ tool: "Bash", at_step: 4, detail: "fixture denial" }]
      : [],
};
process.stdout.write(`${JSON.stringify(response)}\n`);
