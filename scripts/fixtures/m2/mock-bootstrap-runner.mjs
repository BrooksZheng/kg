#!/usr/bin/env node

// Deterministic runner fixture for evaluator regression. It uses no provider.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const inventoryScript = path.join(request.project_root, ".agents", "skills", "kg-docs", "scripts", "inventory.mjs");
const bootstrapScript = path.join(request.project_root, ".agents", "skills", "kg-docs", "scripts", "bootstrap.mjs");
const inventory = path.join(request.artifacts_dir, "repository-inventory.json");
const plan = path.join(request.artifacts_dir, "bootstrap-plan.json");
const document = path.join(request.project_root, "docs", "architecture", "overview.md");

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: request.project_root,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || "fixture command failed");
    process.exit(result.status || 1);
  }
}

const inventoryArgs = [
  "--root",
  request.project_root,
  "--output",
  inventory,
  "--now",
  "2026-07-31T00:00:00Z",
];
run(inventoryScript, inventoryArgs);

const planValue = {
  kind: "kg.docs_bootstrap_plan",
  version: 1,
  title: "KG docs bootstrap fixture architecture",
  coverage_limitations: [],
  observed_facts: [
    {
      section: "context",
      statement: "The application exposes an order lookup route.",
      source: { path: "src/server.mjs", line_start: 4, line_end: 6 },
    },
    {
      section: "building_blocks",
      statement: "The HTTP entrypoint delegates order loading to a separate module.",
      source: { path: "src/server.mjs", line_start: 1, line_end: 1 },
    },
    {
      section: "runtime",
      statement: "An order request calls loadOrder with the path identifier.",
      source: { path: "src/server.mjs", line_start: 4, line_end: 6 },
    },
    {
      section: "deployment",
      statement: "The package start command launches src/server.mjs.",
      source: { path: "package.json", line_start: 5, line_end: 5 },
    },
  ],
  inferences: [
    {
      section: "context",
      statement: "The order service depends on an external HTTP boundary.",
      confidence: 0.9,
      sources: [{ path: "src/order-service.mjs", line_start: 2, line_end: 2 }],
    },
  ],
};
fs.writeFileSync(plan, `${JSON.stringify(planValue, null, 2)}\n`);

const bootstrapArgs = [
  "--project-root",
  request.project_root,
  "--inventory",
  inventory,
  "--plan",
  plan,
];
run(bootstrapScript, bootstrapArgs);

const command = (script, args) => [process.execPath, script, ...args].map((value) => JSON.stringify(value)).join(" ");
const response = {
  session_id: "fixture-bootstrap-session",
  transcript: [
    {
      role: "assistant",
      content: "The inventory, JSON plan, and architecture draft were created through the required scripts.",
      tool_calls: [],
    },
  ],
  file_reads: [
    { path: "package.json", at_step: 2 },
    { path: "src/server.mjs", at_step: 2 },
    { path: "src/order-service.mjs", at_step: 2 },
  ],
  citations: [
    { path: "src/server.mjs", line: 4 },
    { path: "src/order-service.mjs", line: 2 },
    { path: "package.json", line: 5 },
  ],
  products: [
    { kind: "kg.repository_inventory", path: inventory },
    { kind: "kg.docs_bootstrap_plan", path: plan },
    { kind: "kg.project_document", path: document },
  ],
  tool_events: [
    { name: "Bash", command: command(inventoryScript, inventoryArgs), at_step: 1, ok: true },
    { name: "Write", command: plan, at_step: 3, ok: true },
    { name: "Bash", command: command(bootstrapScript, bootstrapArgs), at_step: 4, ok: true },
  ].filter((event) => !(process.env.KG_FAKE_MISSING_TOOL === "1" && event.command.includes("inventory.mjs"))),
  permission_denials: process.env.KG_FAKE_DENIAL === "1"
    ? [{ tool: "Bash", at_step: 3, detail: "fixture denial" }]
    : [],
};
process.stdout.write(`${JSON.stringify(response)}\n`);
