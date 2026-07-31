#!/usr/bin/env node

// Deterministic Runner Contract 1.1 fixture for G-D evaluator regressions.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const compileScript = path.join(request.project_root, ".agents", "skills", "kg-compile", "scripts", "compile.mjs");
const applyScript = path.join(request.project_root, ".agents", "skills", "kg-compile", "scripts", "apply-compile-plan.mjs");
const contextFile = path.join(request.artifacts_dir, "compile-context.json");
const planFile = path.join(request.artifacts_dir, "compile-plan.json");
const fixedNow = "2026-07-31T03:00:00Z";

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
  return result;
}

const compileArgs = ["--root", request.project_root, "--output", contextFile, "--now", fixedNow];
run(compileScript, compileArgs);
const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
const requiredReads = [
  ...context.observations.map((input) => input.path),
  ...context.knowledge_entries.map((input) => input.path),
  ...context.accepted_documents.map((input) => input.path),
  ...context.artifacts.flatMap((artifact) => [artifact.sidecar_path, artifact.target_path]),
];
for (const relative of requiredReads) {
  fs.readFileSync(path.join(request.project_root, ...relative.split("/")));
}

const plan = {
  kind: "kg.compile_plan",
  version: 1,
  items: [
    {
      observation_id: "OBS-20260731-101",
      result_type: "publish_kn_and_carrier",
      knowledge: {
        claim: "Compile-managed runbooks must preserve human text outside their managed block.",
        category: "project_knowledge",
        scope: { paths: ["docs/runbooks/**"] },
        authority: "verified_runtime_behavior",
        confidence: 1,
        body: "## Constraint\n\nManaged carrier updates replace only the uniquely identified marker content.",
      },
      carrier: {
        artifact_id: "HAR-COMPILE-NOTES",
        content: "Compile updates this block while preserving both surrounding human sections.",
      },
    },
    {
      observation_id: "OBS-20260731-102",
      result_type: "queue_only",
      queue: {
        claim: "A human must rule on the fixture conflict before publication.",
        evidence: [{ type: "quote", ref: "compile fixture queue-only path" }],
        options: ["accept the claim", "reject the claim"],
        recommendation: "Keep the claim out of the ledger until a human resolves the conflict.",
      },
    },
    {
      observation_id: "OBS-20260731-103",
      result_type: "no_change",
      reason: "KN-0001 already contains the same claim and scope.",
    },
  ],
};
fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

const applyArgs = [
  "--root",
  request.project_root,
  "--context",
  contextFile,
  "--plan",
  planFile,
  "--now",
  fixedNow,
];
const applied = run(applyScript, applyArgs);
const reportMatch = /-> ([^\s]+)$/.exec(applied.stdout.trim());
const reportFile = reportMatch ? path.join(request.project_root, ...reportMatch[1].split("/")) : "";

const toolEvents = [
  ...(process.env.KG_FAKE_FAILED_EXPLORATION === "1"
    ? [
        {
          name: "Read",
          command: path.join(request.project_root, ".kg", "protocol", "routing.yaml"),
          at_step: 2,
          ok: false,
        },
      ]
    : []),
  { name: "Bash", command: command(compileScript, compileArgs), at_step: 1, ok: true },
  {
    name: process.env.KG_FAKE_SHELL_PLAN === "1" ? "Bash" : "Write",
    command: planFile,
    at_step: process.env.KG_FAKE_WRONG_ORDER === "1" ? 0 : 3,
    ok: true,
  },
  { name: "Bash", command: command(applyScript, applyArgs), at_step: 4, ok: true },
].filter(
  (event) =>
    !(
      process.env.KG_FAKE_MISSING_TOOL === "1" &&
      event.command.includes("apply-compile-plan.mjs")
    ),
);
const readStep = process.env.KG_FAKE_EARLY_READ === "1" ? 0 : 2;
const fileReads = requiredReads.map((readPath) => ({ path: readPath, at_step: readStep }));
if (process.env.KG_FAKE_MISSING_READ === "1") fileReads.pop();

const response = {
  session_id: "fixture-compile-session",
  transcript: [
    {
      role: "assistant",
      content: "The compile context, JSON plan, apply step, and machine report were completed.",
      tool_calls: [],
    },
  ],
  file_reads: fileReads,
  citations: requiredReads.map((readPath) => ({ path: readPath })),
  products: [
    { kind: "kg.compile_context", path: contextFile },
    { kind: "kg.compile_plan", path: planFile },
    { kind: "kg.compile_report", path: reportFile },
  ],
  tool_events: toolEvents,
  permission_denials:
    process.env.KG_FAKE_DENIAL === "1"
      ? [{ tool: "Bash", at_step: 4, detail: "fixture denial" }]
      : [],
};
process.stdout.write(`${JSON.stringify(response)}\n`);
