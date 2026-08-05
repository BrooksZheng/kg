#!/usr/bin/env node

// Convert agent-selected index entries into one script-bound deep-read scope.
// Every reason is validated against the protocol table and recomputed from
// transcript, structured scope, or graph evidence.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host, kyaml, machineContract, protocol } from "./_lib.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(["--project-root", "--index", "--transcript", "--input", "--output", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  for (const field of ["project_root", "index", "transcript", "input", "output"]) {
    if (!out[field]) fail(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function readInputFile(value, label, { machine = false } = {}) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg")) throw new Error(`${label} must not enter .kg`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is not a file`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  try {
    const text = fs.readFileSync(file, "utf8");
    const value = machine && path.extname(file).toLowerCase() !== ".json" && !text.trimStart().startsWith("{")
      ? kyaml.parse(text)
      : JSON.parse(text);
    return { file: host.canonicalPath(file), value };
  } catch (error) {
    throw new Error(`${label} must be ${machine ? "a machine record" : "strict JSON"}: ${error.message}`);
  }
}

function transcriptMessages(raw) {
  const messages = Array.isArray(raw) ? raw : raw?.transcript;
  if (!Array.isArray(messages)) throw new Error("transcript must be a list or contain a transcript list");
  for (const [index, message] of messages.entries()) {
    if (message === null || typeof message !== "object" || Array.isArray(message) ||
        !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error(`transcript[${index}] is invalid`);
    }
  }
  return messages;
}

function outputFile(value) {
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase())) throw new Error("output must use .json or .yaml");
  if (host.hasPathSegment(file, ".kg")) throw new Error("output must not enter .kg");
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite scope: ${file}`);
  return file;
}

function transcriptContains(messages, literal, roles = ["user"]) {
  return messages.some((message) => roles.includes(message.role) && message.content.includes(literal));
}

function scopeStrings(metadata) {
  const scope = metadata?.scope;
  if (typeof scope === "string") return [scope];
  if (Array.isArray(scope)) return scope.map(String);
  if (scope && typeof scope === "object") {
    return Object.values(scope).flatMap((value) => Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []);
  }
  return [];
}

function scopeIntersects(scopeValue, confirmedPath) {
  const normalized = String(scopeValue).replaceAll("\\", "/");
  const prefix = normalized.split("*")[0].replace(/\/$/, "");
  return prefix !== "" && (confirmedPath === prefix || confirmedPath.startsWith(`${prefix}/`) || prefix.startsWith(`${confirmedPath}/`));
}

function directlyGrounded(entry, messages) {
  if (transcriptContains(messages, entry.path)) return true;
  return entry.domain_keys.some((domain) => transcriptContains(messages, domain));
}

function validateBasis({ selection, entry, index, messages, scopeSchema }) {
  const reasonRow = scopeSchema.scope_reasons[selection.reason];
  if (!reasonRow) throw new Error(`unknown scope reason: ${selection.reason}`);
  if (selection.basis_type !== reasonRow.basis_type) {
    throw new Error(`${selection.source_path} basis_type must be ${reasonRow.basis_type} for ${selection.reason}`);
  }
  const pattern = scopeSchema.basis_ref_patterns[selection.basis_type];
  if (!pattern || !new RegExp(pattern).test(selection.basis_ref)) {
    throw new Error(`${selection.source_path} basis_ref does not match protocol pattern for ${selection.basis_type}`);
  }
  if (selection.basis_type === "transcript_literal") {
    const match = /^message:([0-9]+):(path|domain):(.+)$/.exec(selection.basis_ref);
    const messageIndex = Number.parseInt(match[1], 10);
    const message = messages[messageIndex];
    if (!message || message.role !== "user" || !message.content.includes(match[3])) {
      throw new Error(`${selection.source_path} transcript literal is absent from the referenced user message`);
    }
    if (match[2] === "path" && match[3] !== entry.path) {
      throw new Error(`${selection.source_path} direct path basis must name the selected path exactly`);
    }
    if (match[2] === "domain" && !entry.domain_keys.includes(match[3].toLowerCase())) {
      throw new Error(`${selection.source_path} direct domain basis is absent from indexed domain_keys`);
    }
    return;
  }
  if (selection.basis_type === "scope_intersection") {
    const match = /^scope:(SRC-[A-F0-9]{12}):(.+)$/.exec(selection.basis_ref);
    const confirmedPath = match[2];
    if (match[1] !== entry.source_id || !transcriptContains(messages, confirmedPath)) {
      throw new Error(`${selection.source_path} scope basis lacks a transcript-confirmed path`);
    }
    if (!scopeStrings(entry.metadata).some((scopeValue) => scopeIntersects(scopeValue, confirmedPath))) {
      throw new Error(`${selection.source_path} indexed scope does not intersect ${confirmedPath}`);
    }
    return;
  }
  if (selection.basis_type === "graph_edge") {
    const match = /^edge:(SRC-[A-F0-9]{12}):(SRC-[A-F0-9]{12}):([a-z_]+)$/.exec(selection.basis_ref);
    const edge = index.edges.find((item) =>
      item.from_source_id === match[1] && item.to_source_id === match[2] && item.edge_type === match[3]);
    if (!edge) throw new Error(`${selection.source_path} graph edge is absent from the index`);
    if (![edge.from_source_id, edge.to_source_id].includes(entry.source_id)) {
      throw new Error(`${selection.source_path} graph edge does not touch the selected source`);
    }
    const otherId = edge.from_source_id === entry.source_id ? edge.to_source_id : edge.from_source_id;
    const other = index.entries.find((item) => item.source_id === otherId);
    if (!other || !directlyGrounded(other, messages)) {
      throw new Error(`${selection.source_path} graph edge does not connect to transcript-confirmed scope`);
    }
    return;
  }
  const match = /^message:([0-9]+):domain:(.+)$/.exec(selection.basis_ref);
  const messageIndex = Number.parseInt(match[1], 10);
  const domain = match[2].toLowerCase();
  const message = messages[messageIndex];
  if (!message || message.role !== "user" || !message.content.includes(match[2]) ||
      messageIndex === 0 || messages[messageIndex - 1]?.role !== "assistant") {
    throw new Error(`${selection.source_path} human-confirmed domain must follow an assistant turn and point to the user reply`);
  }
  if (!entry.domain_keys.includes(domain)) {
    throw new Error(`${selection.source_path} confirmed domain is absent from indexed domain_keys`);
  }
}

function buildScope({ root, indexFile, transcript, raw, output, now }) {
  const indexSchema = protocol.loadKickoffIndexSchema();
  const scopeSchema = protocol.loadKickoffScopeSchema();
  const indexErrors = protocol.validateRecord(indexFile.value, indexSchema);
  if (indexErrors.length > 0) throw new Error(`index is invalid: ${indexErrors.join("; ")}`);
  if (host.canonicalPath(indexFile.value.project_root) !== root) throw new Error("index project_root differs from --project-root");
  machineContract.assertRawInput(raw, scopeSchema, "kickoff scope");
  if (!transcript.some((message) => message.role === "user" && machineContract.sha256Bytes(message.content) === indexFile.value.task_sha256)) {
    throw new Error("transcript does not contain the task bytes bound by the index");
  }
  const byPath = new Map(indexFile.value.entries.map((entry) => [entry.path, entry]));
  const selections = raw.selected_sources.map((selection) => {
    const resolved = machineContract.resolveCanonicalPath(root, selection.source_path);
    if (resolved.relative !== selection.source_path) throw new Error(`source_path is not canonical: ${selection.source_path}`);
    const entry = byPath.get(selection.source_path);
    if (!entry) throw new Error(`selected source is absent from index: ${selection.source_path}`);
    validateBasis({ selection, entry, index: indexFile.value, messages: transcript, scopeSchema });
    const sha256 = machineContract.sha256File(resolved.full);
    if (sha256 !== entry.sha256) throw new Error(`selected source changed after index: ${selection.source_path}`);
    return { ...selection, source_sha256: sha256 };
  }).sort((left, right) => left.source_path.localeCompare(right.source_path));
  const indexSha256 = machineContract.sha256File(indexFile.file);
  const seed = machineContract.sha256CanonicalJson({ index_sha256: indexSha256, selections });
  const record = machineContract.buildCanonicalRecord(
    { ...raw, selected_sources: selections.map(({ source_sha256, ...selection }) => selection) },
    {
      kind: scopeSchema.product_kind,
      version: scopeSchema.product_version,
      scope_id: `KSCOPE-${seed.slice(-12).toUpperCase()}`,
      created_at: now.toISOString(),
      index_sha256: indexSha256,
      task_sha256: indexFile.value.task_sha256,
      selected_sources: selections,
    },
    scopeSchema,
    "kickoff scope",
  );
  machineContract.writeCanonicalRecord(output, record, scopeSchema, { label: "kickoff scope" });
  return record;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const root = host.assertSafeHostRoot(args.project_root);
    const indexFile = readInputFile(args.index, "index", { machine: true });
    const transcript = transcriptMessages(readInputFile(args.transcript, "transcript").value);
    const raw = readInputFile(args.input, "input").value;
    const output = outputFile(args.output);
    const record = buildScope({ root, indexFile, transcript, raw, output, now: args.now });
    console.log(`kg: wrote scope ${record.scope_id} with ${record.selected_sources.length} source(s)`);
  } catch (error) {
    fail(error.message);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) main();
