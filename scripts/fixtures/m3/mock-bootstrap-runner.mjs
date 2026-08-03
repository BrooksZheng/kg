#!/usr/bin/env node

// Deterministic version 2 runner used only to regression-test the evaluator.
// It receives the same request envelope as a real runner and has no oracle path.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const skillRoot = path.join(request.project_root, ".agents", "skills", "kg-docs");
const inventoryScript = path.join(skillRoot, "scripts", "inventory.mjs");
const bootstrapScript = path.join(skillRoot, "scripts", "bootstrap.mjs");
const inventory = path.join(request.artifacts_dir, "repository-inventory.json");
const plan = path.join(request.artifacts_dir, "bootstrap-plan.json");
const { protocol } = await import(pathToFileURL(path.join(skillRoot, "scripts", "_lib.mjs")).href);

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: request.project_root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || "fixture command failed");
    process.exit(result.status || 1);
  }
}

const inventoryArgs = ["--root", request.project_root, "--output", inventory, "--now", "2026-08-03T00:00:00Z"];
run(inventoryScript, inventoryArgs);
const taxonomy = protocol.loadDocumentTaxonomy();
const evidence = [
  { path: "package.json", line_start: 5, line_end: 5 },
  { path: "src/server.mjs", line_start: 1, line_end: 1 },
  { path: "src/order-store.mjs", line_start: 1, line_end: 1 },
];
let evidenceIndex = 0;
const documents = taxonomy.core_types.map((docType) => {
  const record = taxonomy.documents[docType];
  const template = fs.readFileSync(path.join(skillRoot, record.template_path.slice("skills/kg-docs/".length)), "utf8");
  const keys = [...template.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)].map((match) => match[1]);
  return {
    doc_type: docType,
    slug: record.create_target_pattern.includes("{slug}") ? `fixture-${docType}` : null,
    title: `Fixture ${docType} draft`,
    mode: "create",
    target_path: null,
    coverage_limitations: [],
    sections: keys.map((key) => {
      if (evidenceIndex < evidence.length) {
        const source = evidence[evidenceIndex++];
        return {
          key,
          findings: [{ classification: "observed_fact", statement: `Observed source ${source.path}.`, sources: [source] }],
        };
      }
      return {
        key,
        findings: [{
          classification: "unknown",
          statement: `Evidence for ${docType} ${key} is incomplete.`,
          sources: [],
          missing_evidence: `The static inventory does not establish ${docType} ${key}.`,
        }],
      };
    }),
  };
});
fs.writeFileSync(plan, `${JSON.stringify({ kind: "kg.docs_bootstrap_plan", version: 2, documents }, null, 2)}\n`);
const bootstrapArgs = ["--project-root", request.project_root, "--inventory", inventory, "--plan", plan];
run(bootstrapScript, bootstrapArgs);

const targetPaths = documents.map((document) => taxonomy.documents[document.doc_type].create_target_pattern
  .replace("{sequence}", "0001")
  .replace("{slug}", document.slug ?? ""));
const command = (script, args) => [process.execPath, script, ...args].map((value) => JSON.stringify(value)).join(" ");
const response = {
  session_id: "fixture-bootstrap-v2-session",
  transcript: [{ role: "assistant", content: "Completed the inventory, plan, and taxonomy-driven draft batch.", tool_calls: [] }],
  file_reads: [
    { path: "package.json", at_step: 2 },
    { path: "src/server.mjs", at_step: 2 },
    { path: "src/order-store.mjs", at_step: 2 },
  ],
  citations: [
    { path: "package.json", line: 5 },
    { path: "src/server.mjs", line: 1 },
    { path: "src/order-store.mjs", line: 1 },
  ],
  products: [
    { kind: "kg.repository_inventory", path: inventory },
    { kind: "kg.docs_bootstrap_plan", path: plan },
    ...targetPaths.map((target) => ({ kind: "kg.project_document", path: path.join(request.project_root, target) })),
  ],
  tool_events: [
    { name: "Bash", command: command(inventoryScript, inventoryArgs), at_step: 1, ok: true },
    { name: "Write", command: `Write ${plan}`, at_step: 3, ok: true },
    { name: "Bash", command: command(bootstrapScript, bootstrapArgs), at_step: 4, ok: true },
  ],
  permission_denials: [],
};
process.stdout.write(`${JSON.stringify(response)}\n`);
