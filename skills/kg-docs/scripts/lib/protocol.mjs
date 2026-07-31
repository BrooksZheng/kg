// Protocol loader + schema-driven record validator.
// The protocol files themselves (protocol/*.yaml, two levels above this lib —
// a layout preserved by both symlink and copy discovery modes) are the single
// source of truth: this module interprets their `fields` specs; it does not
// hardcode field lists.
//
// Run `node scripts/lib/protocol.mjs` for a self-check that all nine protocol
// files parse and are internally coherent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, KyamlError } from "./kyaml.mjs";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = path.join(LIB_DIR, "..", "..", "protocol");

export function loadProtocolFile(name) {
  const file = path.join(PROTOCOL_DIR, name);
  return parse(fs.readFileSync(file, "utf8"));
}

export const loadObservationSchema = () => loadProtocolFile("observation.schema.yaml");
export const loadKnowledgeSchema = () => loadProtocolFile("knowledge.schema.yaml");
export const loadProjectDocumentSchema = () => loadProtocolFile("project-document.schema.yaml");
export const loadHarnessSchema = () => loadProtocolFile("harness.schema.yaml");
export const loadTaskSpecSchema = () => loadProtocolFile("task-spec.schema.yaml");
export const loadDocumentTaxonomy = () => loadProtocolFile("document-taxonomy.yaml");
export const loadLifecycle = () => loadProtocolFile("lifecycle.yaml");
export const loadAuthority = () => loadProtocolFile("authority.yaml");
export const loadRouting = () => loadProtocolFile("routing.yaml");

// --- generic record validation against a schema's `fields` specs -----------
// Spec paths: `field` (top level), `field.sub` (one-level nested map),
// `field[].sub` (items of a list of maps). Unknown keys are rejected.

export function validateRecord(record, schema) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["record must be a mapping"];
  }
  const topSpecs = {};
  const subSpecs = {};
  const itemSpecs = {};
  for (const [specPath, spec] of Object.entries(schema.fields)) {
    if (specPath.includes("[].")) {
      const [field, sub] = specPath.split("[].");
      (itemSpecs[field] ??= {})[sub] = spec;
    } else if (specPath.includes(".")) {
      const [field, sub] = specPath.split(".");
      (subSpecs[field] ??= {})[sub] = spec;
    } else {
      topSpecs[specPath] = spec;
    }
  }
  checkMap(record, topSpecs, "", errors, { subSpecs, itemSpecs });
  return errors;
}

function checkMap(obj, specs, prefix, errors, ctx) {
  for (const key of Object.keys(obj)) {
    if (!specs[key]) errors.push(`${prefix}${key}: unknown field`);
  }
  for (const [key, spec] of Object.entries(specs)) {
    const label = `${prefix}${key}`;
    const value = obj[key];
    if (value === undefined || (value === null && spec.type !== "string_or_null" && spec.type !== "map")) {
      if (spec.required) errors.push(`${label}: required field is missing`);
      continue;
    }
    checkValue(value, spec, key, label, errors, ctx);
  }
}

function checkValue(value, spec, fieldKey, label, errors, ctx) {
  switch (spec.type) {
    case "string":
    case "string_or_null": {
      if (value === null) {
        if (spec.type === "string") errors.push(`${label}: must be a non-empty string`);
        return;
      }
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${label}: must be a non-empty string`);
        return;
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        errors.push(`${label}: \`${value}\` does not match ${spec.pattern}`);
      }
      return;
    }
    case "timestamp": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
        errors.push(`${label}: must be an ISO-8601 timestamp (e.g. 2026-07-12T07:30:00Z)`);
      }
      return;
    }
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push(`${label}: must be a date (YYYY-MM-DD)`);
      }
      return;
    }
    case "enum": {
      const allowed = String(spec.values).split("|");
      if (typeof value !== "string" || !allowed.includes(value)) {
        errors.push(`${label}: \`${value}\` is not one of: ${allowed.join(" | ")}`);
      }
      return;
    }
    case "float": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`${label}: must be a number`);
        return;
      }
      if (spec.min !== undefined && value < spec.min) errors.push(`${label}: below minimum ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) errors.push(`${label}: above maximum ${spec.max}`);
      return;
    }
    case "string_list": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
        errors.push(`${label}: must be a list of non-empty strings`);
      }
      return;
    }
    case "map": {
      if (value === null) return; // an empty `key:` block is an empty map
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${label}: must be a mapping`);
        return;
      }
      const specs = ctx.subSpecs[fieldKey];
      if (specs) checkMap(value, specs, `${label}.`, errors, ctx);
      return;
    }
    case "map_list": {
      if (!Array.isArray(value) || !value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
        errors.push(`${label}: must be a list of mappings`);
        return;
      }
      if (spec.min_items !== undefined && value.length < spec.min_items) {
        errors.push(`${label}: needs at least ${spec.min_items} item(s)`);
      }
      const specs = ctx.itemSpecs[fieldKey];
      if (specs) {
        value.forEach((item, i) => checkMap(item, specs, `${label}[${i}].`, errors, ctx));
      }
      return;
    }
    default:
      errors.push(`${label}: schema bug — unknown spec type \`${spec.type}\``);
  }
}

// --- markdown frontmatter ---------------------------------------------------

export function splitFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== "---") throw new KyamlError("file must start with a `---` frontmatter fence");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new KyamlError("frontmatter closing `---` not found");
  return {
    frontmatter: parse(lines.slice(1, end).join("\n")),
    body: lines.slice(end + 1).join("\n"),
  };
}

export function renderFrontmatterDoc(frontmatter, body) {
  const { stringify } = requireKyaml();
  return `---\n${stringify(frontmatter)}---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

// Small indirection so this file has a single import list at the top.
import * as kyaml from "./kyaml.mjs";
function requireKyaml() {
  return kyaml;
}

// --- self-check --------------------------------------------------------------

// Realpath both sides: Node ESM resolves import.meta.url through symlinks, so
// a symlink-installed copy would otherwise never detect direct invocation.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  const problems = [];
  const files = [
    "observation.schema.yaml",
    "knowledge.schema.yaml",
    "project-document.schema.yaml",
    "harness.schema.yaml",
    "task-spec.schema.yaml",
    "document-taxonomy.yaml",
    "lifecycle.yaml",
    "authority.yaml",
    "routing.yaml",
  ];
  const docs = {};
  for (const f of files) {
    try {
      docs[f] = loadProtocolFile(f);
    } catch (err) {
      problems.push(`${f}: ${err.message}`);
    }
  }
  const lc = docs["lifecycle.yaml"];
  if (lc) {
    for (const [from, to] of Object.entries(lc.transitions)) {
      if (!lc.states.includes(from)) problems.push(`lifecycle: unknown state \`${from}\``);
      for (const t of to === "" ? [] : to.split("|")) {
        if (!lc.states.includes(t)) problems.push(`lifecycle: transition ${from} -> unknown state \`${t}\``);
      }
    }
  }
  const routing = docs["routing.yaml"];
  const kn = docs["knowledge.schema.yaml"];
  if (routing && kn) {
    const cats = String(kn.fields.category.values).split("|");
    for (const c of cats) {
      if (!routing.categories[c]) problems.push(`routing: knowledge category \`${c}\` missing from routing table`);
    }
  }
  const auth = docs["authority.yaml"];
  if (auth && kn) {
    const levels = String(kn.fields.authority.values).split("|");
    for (const l of levels) {
      if (!auth.ranking.includes(l)) problems.push(`authority: knowledge authority \`${l}\` missing from ranking`);
    }
  }
  const harness = docs["harness.schema.yaml"];
  if (routing && harness) {
    if (
      routing.version !== 2 ||
      routing.stages?.observation_to_knowledge !== "observation_to_knowledge" ||
      routing.stages?.knowledge_to_harness !== "knowledge_to_harness"
    ) {
      problems.push("routing: both v2 compile stages are required");
    }
    const routedCarriers = Object.keys(routing.harness_carriers ?? {});
    const allowedCarriers = String(harness.fields?.type?.values ?? "").split("|");
    for (const carrier of routedCarriers) {
      if (!allowedCarriers.includes(carrier)) {
        problems.push(`harness: routed carrier \`${carrier}\` missing from harness type enum`);
      }
    }
    for (const role of ["route_target", "dedupe_baseline", "conflict_baseline"]) {
      if (!routing.compile_document_roles?.[role]) {
        problems.push(`routing: compile document role \`${role}\` missing`);
      }
    }
    const requiredHarnessFields = [
      "artifact_id",
      "type",
      "path",
      "ownership",
      "status",
      "source_kn_ids",
      "source_refs",
      "content_hash",
      "generator_version",
      "last_verified",
      "update_policy",
    ];
    for (const field of requiredHarnessFields) {
      if (!harness.fields?.[field]?.required) problems.push(`harness: required field \`${field}\` missing`);
    }
    if (harness.fields?.ownership?.values !== "managed|co_managed|human") {
      problems.push("harness: ownership enum must be managed|co_managed|human");
    }
    for (const field of ["source_obs_ids", "carrier_refs"]) {
      if (kn.fields?.[field]?.type !== "string_list" || kn.fields?.[field]?.required !== false) {
        problems.push(`knowledge: optional v2 trace field \`${field}\` missing`);
      }
    }
  }
  const observation = docs["observation.schema.yaml"];
  if (
    observation?.fields?.compiled_to_kn?.type !== "string_or_null" ||
    observation?.fields?.compiled_to_kn?.required !== false ||
    observation?.fields?.compiled_to_kn?.pattern !== "^KN-[0-9]{4}$"
  ) {
    problems.push("observation: optional compile-owned compiled_to_kn field is invalid");
  }
  const taxonomy = docs["document-taxonomy.yaml"];
  const projectDocument = docs["project-document.schema.yaml"];
  if (taxonomy && projectDocument) {
    if (projectDocument.version !== 1) problems.push("project-document: version must remain 1");
    const allowedTypes = String(projectDocument.fields?.doc_type?.values ?? "").split("|");
    for (const docType of [...(taxonomy.core_types ?? []), taxonomy.spec_type]) {
      if (!allowedTypes.includes(docType)) {
        problems.push(`taxonomy: document type \`${docType}\` missing from project-document enum`);
      }
      const record = taxonomy.documents?.[docType];
      for (const key of [
        "path",
        "template_path",
        "diataxis_quadrant",
        "arc42_sections",
        "detection_rule",
        "lazy_create_when",
      ]) {
        if (!record?.[key]) problems.push(`taxonomy: ${docType}.${key} missing`);
      }
    }
    if (taxonomy.tutorials?.diataxis_quadrant !== "excluded" || !taxonomy.tutorials?.exclusion_rationale) {
      problems.push("taxonomy: tutorials exclusion and rationale are required");
    }
  }
  const taskSpec = docs["task-spec.schema.yaml"];
  if (taskSpec) {
    if (taskSpec.document_kind !== "kg.task_spec") {
      problems.push("task-spec: document_kind must be `kg.task_spec`");
    }
    const expectedSections = [
      "Context",
      "Requirements",
      "Constraints",
      "References",
      "Out of Scope",
      "Acceptance Criteria",
      "Open Questions",
      "Session History",
    ];
    for (const section of expectedSections) {
      if (!taskSpec.required_sections?.includes(section)) {
        problems.push(`task-spec: required section \`${section}\` missing`);
      }
    }
    if (
      taskSpec.constraint_source_path_pattern !==
      "^(docs/.+\\.md|knowledge/KN-[^/]+\\.md|AGENTS\\.md)#L[1-9][0-9]*$"
    ) {
      problems.push("task-spec: stable document anchor pattern is invalid");
    }
    if (!String(taskSpec.acceptance_format ?? "").includes("GIVEN") ||
        !String(taskSpec.acceptance_format ?? "").includes("WHEN") ||
        !String(taskSpec.acceptance_format ?? "").includes("THEN")) {
      problems.push("task-spec: acceptance format must require GIVEN, WHEN, and THEN");
    }
  }
  if (problems.length) {
    console.error("protocol self-check FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`protocol self-check OK (${files.length} files parsed, cross-references coherent)`);
}
