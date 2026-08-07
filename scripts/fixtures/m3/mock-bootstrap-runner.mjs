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
const storePath = fs.existsSync(path.join(request.project_root, "src", "order-store.mjs"))
  ? "src/order-store.mjs"
  : "src/shipment-store.mjs";
const evidence = [
  { path: "package.json", line_start: 2, line_end: 2 },
  { path: "src/server.mjs", line_start: 1, line_end: 1 },
  { path: storePath, line_start: 1, line_end: 1 },
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePattern(pattern) {
  const parts = pattern.split(/(\{sequence\}|\{slug\})/g);
  return new RegExp(`^${parts.map((part) => {
    if (part === "{sequence}") return "(?<sequence>[0-9]{4})";
    if (part === "{slug}") return "(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)";
    return escapeRegex(part);
  }).join("")}$`);
}

function existingTarget(record) {
  if (!record.create_target_pattern.includes("{")) {
    return fs.existsSync(path.join(request.project_root, record.create_target_pattern))
      ? { targetPath: record.create_target_pattern, slug: null }
      : null;
  }
  const directory = path.posix.dirname(record.create_target_pattern);
  const full = path.join(request.project_root, directory);
  if (!fs.existsSync(full)) return null;
  const matcher = routePattern(record.create_target_pattern);
  const matches = fs.readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.posix.join(directory, entry.name))
    .map((targetPath) => ({ targetPath, match: matcher.exec(targetPath) }))
    .filter((item) => item.match);
  if (matches.length !== 1) return null;
  return { targetPath: matches[0].targetPath, slug: matches[0].match.groups?.slug ?? null };
}

let evidenceIndex = 0;
const documents = taxonomy.core_types.map((docType) => {
  const record = taxonomy.documents[docType];
  const template = fs.readFileSync(path.join(skillRoot, record.template_path.slice("skills/kg-docs/".length)), "utf8");
  const keys = [...template.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)].map((match) => match[1]);
  const existing = existingTarget(record);
  return {
    doc_type: docType,
    slug: existing?.slug ?? (record.create_target_pattern.includes("{slug}") ? `fixture-${docType}` : null),
    title: `Fixture ${docType} draft`,
    mode: existing ? "proposal" : "create",
    target_path: existing?.targetPath ?? null,
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

const createTargetPaths = documents.filter((document) => document.mode === "create").map((document) => {
  const pattern = taxonomy.documents[document.doc_type].create_target_pattern;
  if (!pattern.includes("{sequence}")) return pattern.replace("{slug}", document.slug ?? "");
  const directory = path.posix.dirname(pattern);
  const matcher = routePattern(pattern.replace("{slug}", document.slug));
  const name = fs.readdirSync(path.join(request.project_root, directory), { withFileTypes: true })
    .find((entry) => entry.isFile() && matcher.test(path.posix.join(directory, entry.name)))?.name;
  if (!name) throw new Error(`created decision target missing for ${document.slug}`);
  return path.posix.join(directory, name);
});
const proposalProducts = [];
const proposalRoot = path.join(request.project_root, "docs", "proposals");
if (fs.existsSync(proposalRoot)) {
  for (const entry of fs.readdirSync(proposalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("bootstrap-")) continue;
    const manifest = path.join(proposalRoot, entry.name, "manifest.json");
    const candidate = path.join(proposalRoot, entry.name, "candidate.md");
    proposalProducts.push(
      { kind: "kg.docs_bootstrap_proposal", path: manifest },
      { kind: "kg.project_document_candidate", path: candidate },
    );
  }
}
const command = (script, args) => [process.execPath, script, ...args].map((value) => JSON.stringify(value)).join(" ");
const response = {
  session_id: "fixture-bootstrap-v2-session",
  transcript: [{ role: "assistant", content: "Completed the inventory, plan, and taxonomy-driven draft batch.", tool_calls: [] }],
  file_reads: [
    { path: "package.json", at_step: 2 },
    { path: "src/server.mjs", at_step: 2 },
    { path: storePath, at_step: 2 },
  ],
  citations: [
    { path: "package.json", line: 2, context: "Project name" },
    { path: "src/server.mjs", line: 1, context: "Store import" },
    { path: storePath, line: 1, context: "Store function" },
  ],
  products: [
    { kind: "kg.repository_inventory", path: inventory },
    { kind: "kg.docs_bootstrap_plan", path: plan },
    ...createTargetPaths.map((target) => ({ kind: "kg.project_document", path: path.join(request.project_root, target) })),
    ...proposalProducts,
  ],
  tool_events: [
    { name: "Bash", command: command(inventoryScript, inventoryArgs), at_step: 1, ok: true },
    { name: "Write", command: `Write ${plan}`, at_step: 3, ok: true },
    { name: "Bash", command: command(bootstrapScript, bootstrapArgs), at_step: 4, ok: true },
  ],
  permission_denials: [],
};
process.stdout.write(`${JSON.stringify(response)}\n`);
