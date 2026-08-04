// Protocol loader + schema-driven record validator.
// The protocol files themselves (protocol/*.yaml, two levels above this lib —
// a layout preserved by both symlink and copy discovery modes) are the single
// source of truth: this module interprets their `fields` specs; it does not
// hardcode field lists.
//
// Run `node scripts/lib/protocol.mjs` for a self-check that all protocol
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
export const loadCompilePlanSchema = () => loadProtocolFile("compile-plan.schema.yaml");
export const loadCompileReportSchema = () => loadProtocolFile("compile-report.schema.yaml");
export const loadQueueSchema = () => loadProtocolFile("queue.schema.yaml");
export const loadProposalManifestSchema = () => loadProtocolFile("proposal-manifest.schema.yaml");
export const loadTaskSpecSchema = () => loadProtocolFile("task-spec.schema.yaml");
export const loadDocumentTaxonomy = () => loadProtocolFile("document-taxonomy.yaml");
export const loadScanPolicy = () => loadProtocolFile("scan.yaml");
export const loadScanReportSchema = () => loadProtocolFile("scan-report.schema.yaml");
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
    if (value === undefined || (value === null && !["string_or_null", "string_or_list_or_null", "map"].includes(spec.type))) {
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
    case "string_or_list_or_null": {
      if (value === null) return;
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0 || !values.every((item) => typeof item === "string" && item.trim() !== "")) {
        errors.push(`${label}: must be a knowledge id string, list, or null`);
        return;
      }
      if (spec.pattern && !values.every((item) => new RegExp(spec.pattern).test(item))) {
        errors.push(`${label}: contains an invalid value`);
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
    case "integer": {
      if (!Number.isInteger(value)) {
        errors.push(`${label}: must be an integer`);
        return;
      }
      if (spec.values !== undefined && !String(spec.values).split("|").includes(String(value))) {
        errors.push(`${label}: \`${value}\` is not one of: ${String(spec.values).split("|").join(" | ")}`);
      }
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
    "compile-plan.schema.yaml",
    "compile-report.schema.yaml",
    "queue.schema.yaml",
    "proposal-manifest.schema.yaml",
    "task-spec.schema.yaml",
    "document-taxonomy.yaml",
    "scan.yaml",
    "scan-report.schema.yaml",
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
      "machine_segment_hash",
      "human_segment_hash",
      "outside_hash",
      "proposal_id",
      "candidate_path",
    ];
    for (const field of requiredHarnessFields) {
      if (!harness.fields?.[field]?.required) problems.push(`harness: required field \`${field}\` missing`);
    }
    if (harness.fields?.ownership?.values !== "managed|co_managed|human") {
      problems.push("harness: ownership enum must be managed|co_managed|human");
    }
    if (harness.version !== 3 || !Array.isArray(harness.field_order)) {
      problems.push("harness: version 3 and explicit field_order are required");
    }
    for (const markerField of [
      "managed_begin",
      "managed_end",
      "co_managed_human_begin",
      "co_managed_human_end",
      "co_managed_machine_begin",
      "co_managed_machine_end",
    ]) {
      if (!harness.marker_syntax?.[markerField]) problems.push(`harness: marker syntax ${markerField} missing`);
    }
    for (const field of ["source_obs_ids", "carrier_refs"]) {
      if (kn.fields?.[field]?.type !== "string_list" || kn.fields?.[field]?.required !== false) {
        problems.push(`knowledge: optional v2 trace field \`${field}\` missing`);
      }
    }
    const regions = new Set(["machine_block", "machine_segment", "whole_target", "none", "reject"]);
    for (const ownership of ["managed", "co_managed", "human"]) {
      const matrix = routing.ownership_update_matrix?.[ownership];
      for (const policy of ["automatic", "proposal_only", "human_only"]) {
        if (!regions.has(matrix?.[policy])) problems.push(`routing: invalid ownership matrix cell ${ownership}/${policy}`);
      }
    }
    if (routing.ownership_update_matrix?.human?.proposal_only !== "whole_target") {
      problems.push("routing: human/proposal_only must name whole_target");
    }
    if (routing.ownership_update_matrix?.human?.human_only !== "none") {
      problems.push("routing: human/human_only must name none");
    }
    if (JSON.stringify(routing).includes("whole_target_proposal")) {
      problems.push("routing: whole_target_proposal is not a region value");
    }
  }
  const routingForShape = routing;
  const planSchema = docs["compile-plan.schema.yaml"];
  const reportSchema = docs["compile-report.schema.yaml"];
  const queueSchema = docs["queue.schema.yaml"];
  const proposalSchema = docs["proposal-manifest.schema.yaml"];
  if (routingForShape && planSchema) {
    const routingActions = [...(routingForShape.actions ?? [])].sort();
    const planDispositions = [...(planSchema.dispositions ?? [])].sort();
    if (JSON.stringify(routingActions) !== JSON.stringify(planDispositions)) {
      problems.push("compile-plan: dispositions must equal routing actions");
    }
    const rankKeys = Object.keys(routingForShape.disposition_rank ?? {}).sort();
    if (JSON.stringify(rankKeys) !== JSON.stringify(routingActions)) {
      problems.push("routing: disposition_rank must cover every action exactly once");
    }
    const ranks = Object.values(routingForShape.disposition_rank ?? {});
    if (new Set(ranks).size !== ranks.length || !ranks.every((value) => Number.isInteger(value))) {
      problems.push("routing: disposition_rank values must be unique integers");
    }
    if (JSON.stringify([...(routingForShape.plan_actors ?? [])].sort()) !== JSON.stringify([...(planSchema.actors ?? [])].sort())) {
      problems.push("compile-plan: actors must equal routing plan_actors");
    }
    if (JSON.stringify([...(routingForShape.plan_update_scopes ?? [])].sort()) !== JSON.stringify([...(planSchema.update_scopes ?? [])].sort())) {
      problems.push("compile-plan: update_scopes must equal routing plan_update_scopes");
    }
    if (JSON.stringify([...(routingForShape.plan_body_actions ?? [])].sort()) !== JSON.stringify([...(planSchema.body_actions ?? [])].sort())) {
      problems.push("compile-plan: body_actions must equal routing plan_body_actions");
    }
  }
  if (reportSchema) {
    if (!Array.isArray(reportSchema.action_field_order) || !reportSchema.action_fields) {
      problems.push("compile-report: action field order and specs are required");
    }
  }
  if (queueSchema) {
    const queueFields = Object.keys(queueSchema.fields ?? {});
    if (JSON.stringify(queueFields) !== JSON.stringify(queueSchema.field_order ?? [])) {
      problems.push("queue: field_order must match fields insertion order");
    }
    if (queueSchema.fields?.resolution_note?.type !== "string_or_null") {
      problems.push("queue: resolution_note must be nullable");
    }
  }
  if (proposalSchema) {
    if (JSON.stringify(Object.keys(proposalSchema.fields ?? {})) !== JSON.stringify(proposalSchema.field_order ?? [])) {
      problems.push("proposal manifest: field_order must match fields insertion order");
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
  const scan = docs["scan.yaml"];
  const scanReport = docs["scan-report.schema.yaml"];
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
      if ((taxonomy.core_types ?? []).includes(docType) && !record?.create_target_pattern) {
        problems.push(`taxonomy: ${docType}.create_target_pattern missing`);
      }
    }
    if (taxonomy.tutorials?.diataxis_quadrant !== "excluded" || !taxonomy.tutorials?.exclusion_rationale) {
      problems.push("taxonomy: tutorials exclusion and rationale are required");
    }
  }
  if (scan) {
    if (scan.kind !== "kg.scan_policy" || scan.version !== 1) {
      problems.push("scan: kind/version is invalid");
    }
    const surface = scan.resident_surface;
    if (!surface || surface.path !== "AGENTS.md") problems.push("scan: resident surface must target AGENTS.md");
    if (!Number.isInteger(surface?.target_lines) || surface.target_lines < 1) {
      problems.push("scan: resident surface target_lines must be a positive integer");
    }
    if (typeof surface?.finding_issue !== "string" || surface.finding_issue.trim() === "") {
      problems.push("scan: resident surface finding_issue is required");
    }
    if (!/^KN-[0-9]{4}$/.test(String(surface?.knowledge_id ?? ""))) {
      problems.push("scan: resident surface knowledge_id must be a KN id");
    }
    if (typeof surface?.guidance !== "string" || surface.guidance.trim() === "") {
      problems.push("scan: resident surface guidance is required");
    }
  }
  if (scanReport) {
    if (scanReport.kind !== "kg.scan_report_schema" || scanReport.version !== 2) {
      problems.push("scan-report: kind/version is invalid");
    }
    if (!Array.isArray(scanReport.field_order) || !Array.isArray(scanReport.finding_field_order)) {
      problems.push("scan-report: field orders are required");
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
