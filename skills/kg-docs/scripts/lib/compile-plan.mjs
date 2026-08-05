// Protocol-driven compile-plan parser. It validates both the M2 legacy input
// and the R4 action/disposition shape used by compile transactions.

import crypto from "node:crypto";
import * as protocol from "./protocol.mjs";

function fail(message) {
  throw new Error(message);
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} fields must be exactly: ${expected.join(", ")}`);
}

function orderedFields(value, fields, label) {
  exactFields(value, fields, label);
}

function fieldRow(value) {
  return String(value).split("|");
}

function validateScope(scope, label) {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) fail(`${label} must be an object`);
  const allowed = new Set(["paths", "domains"]);
  for (const key of Object.keys(scope)) {
    if (!allowed.has(key)) fail(`${label} has unknown field: ${key}`);
    if (!Array.isArray(scope[key]) || !scope[key].every((item) => typeof item === "string" && item.trim() !== "")) {
      fail(`${label}.${key} must be a list of non-empty strings`);
    }
  }
}

function validateEvidence(evidence, label) {
  if (!Array.isArray(evidence) || evidence.length === 0) fail(`${label} must contain at least one evidence item`);
  const fields = ["type", "ref"];
  const allowed = new Set(["diff", "test", "log", "quote"]);
  for (const [index, item] of evidence.entries()) {
    exactFields(item, fields, `${label}[${index}]`);
    if (!allowed.has(item.type)) fail(`${label}[${index}].type is invalid`);
    if (typeof item.ref !== "string" || item.ref.trim() === "") fail(`${label}[${index}].ref is required`);
  }
}

function validateKnowledge(value, label) {
  const fields = ["claim", "category", "scope", "authority", "confidence", "body"];
  exactFields(value, fields, label);
  if (typeof value.claim !== "string" || value.claim.trim() === "") fail(`${label}.claim is required`);
  const routing = protocol.loadRouting();
  const categoryValues = String(protocol.loadKnowledgeSchema().fields.category.values).split("|");
  if (!categoryValues.includes(value.category)) fail(`${label}.category is invalid`);
  if (!routing.categories[value.category]) fail(`${label}.category is not routed by protocol`);
  validateScope(value.scope, `${label}.scope`);
  const authorityValues = String(protocol.loadKnowledgeSchema().fields.authority.values).split("|");
  if (!authorityValues.includes(value.authority)) fail(`${label}.authority is invalid`);
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) fail(`${label}.confidence must be between 0 and 1`);
  if (typeof value.body !== "string" || value.body.trim() === "") fail(`${label}.body is required`);
}

function validateCarrier(value, label) {
  exactFields(value, ["artifact_id", "content"], label);
  if (!/^HAR-[A-Z0-9][A-Z0-9._-]*$/.test(value.artifact_id)) fail(`${label}.artifact_id is invalid`);
  if (typeof value.content !== "string" || value.content.trim() === "") fail(`${label}.content is required`);
}

function validateQueue(value, label) {
  exactFields(value, ["claim", "evidence", "options", "recommendation"], label);
  if (typeof value.claim !== "string" || value.claim.trim() === "") fail(`${label}.claim is required`);
  if (typeof value.recommendation !== "string" || value.recommendation.trim() === "") fail(`${label}.recommendation is required`);
  validateEvidence(value.evidence, `${label}.evidence`);
  if (!Array.isArray(value.options) || value.options.length < 2 || !value.options.every((item) => typeof item === "string" && item.trim() !== "")) {
    fail(`${label}.options must contain at least two non-empty strings`);
  }
}

function validateLegacyPlan(plan, schema) {
  orderedFields(plan, schema.field_order, "compile plan");
  if (plan.kind !== "kg.compile_plan" || plan.version !== 1) fail("legacy compile plan kind/version is invalid");
  if (!Array.isArray(plan.items) || plan.items.length === 0) fail("compile plan items must be a non-empty array");
  const allowedTypes = Object.keys(schema.legacy_item_fields);
  const observations = new Set();
  let publishCount = 0;
  for (const [index, item] of plan.items.entries()) {
    const label = `compile plan items[${index}]`;
    const type = item?.result_type;
    if (!allowedTypes.includes(type)) fail(`${label}.result_type is not a protocol legacy result type`);
    exactFields(item, fieldRow(schema.legacy_item_fields[type]), label);
    if (!/^OBS-[0-9]{8}-[0-9]{3}$/.test(item.observation_id)) fail(`${label}.observation_id is invalid`);
    if (observations.has(item.observation_id)) fail(`compile plan repeats observation ${item.observation_id}`);
    observations.add(item.observation_id);
    if (type === "publish_kn_and_carrier") {
      publishCount += 1;
      validateKnowledge(item.knowledge, `${label}.knowledge`);
      validateCarrier(item.carrier, `${label}.carrier`);
    } else if (type === "queue_only") {
      validateQueue(item.queue, `${label}.queue`);
    } else if (typeof item.reason !== "string" || item.reason.trim() === "") {
      fail(`${label}.reason is required`);
    }
  }
  if (publishCount > 1) fail("legacy compile plan supports at most one publish item");
  return plan;
}

function validateV2Plan(plan, schema) {
  orderedFields(plan, schema.field_order, "compile plan");
  if (plan.kind !== "kg.compile_plan" || plan.version !== 2) fail("compile plan kind/version is invalid");
  if (!Array.isArray(plan.items) || plan.items.length === 0) fail("compile plan items must be a non-empty array");
  const routing = protocol.loadRouting();
  const observations = new Set();
  for (const [index, item] of plan.items.entries()) {
    const label = `compile plan items[${index}]`;
    const disposition = item?.disposition;
    const fields = schema.item_fields?.[disposition];
    if (!fields) fail(`${label}.disposition is not in protocol`);
    exactFields(item, fieldRow(fields), label);
    if (!/^OBS-[0-9]{8}-[0-9]{3}$/.test(item.observation_id)) fail(`${label}.observation_id is invalid`);
    if (observations.has(item.observation_id)) fail(`compile plan repeats observation ${item.observation_id}`);
    observations.add(item.observation_id);
    if (!schema.dispositions.includes(disposition)) fail(`${label}.disposition is invalid`);
    if (!routing.plan_actors.includes(item.actor)) fail(`${label}.actor is invalid`);
    if (!routing.plan_update_scopes.includes(item.update_scope)) fail(`${label}.update_scope is invalid`);
    if (item.body_action !== undefined && !routing.plan_body_actions.includes(item.body_action)) fail(`${label}.body_action is invalid`);
    if (["update", "merge", "demote", "retire"].includes(disposition) && !/^KN-[0-9]{4}$/.test(item.target_kn_id)) {
      fail(`${label}.target_kn_id is required for ${disposition}`);
    }
    if (["add", "update", "candidate"].includes(disposition)) {
      validateKnowledge(item.knowledge, `${label}.knowledge`);
      validateCarrier(item.carrier, `${label}.carrier`);
    }
    if (disposition === "candidate") validateQueue(item.queue, `${label}.queue`);
    if (["demote", "retire"].includes(disposition) && (typeof item.regret !== "string" || item.regret.trim() === "")) {
      fail(`${label}.regret is required for ${disposition}`);
    }
    if (["merge", "no_change"].includes(disposition) && (typeof item.reason !== "string" || item.reason.trim() === "")) {
      fail(`${label}.reason is required for ${disposition}`);
    }
  }
  return plan;
}

export function validateCompilePlan(plan) {
  const schema = protocol.loadCompilePlanSchema();
  if (plan?.version === 1) return validateLegacyPlan(plan, schema);
  if (plan?.version === 2) return validateV2Plan(plan, schema);
  fail("compile plan kind/version is invalid");
}

export function dispositionRank(disposition) {
  const rank = protocol.loadRouting().disposition_rank?.[disposition];
  if (!Number.isInteger(rank)) fail(`disposition rank is missing from protocol: ${disposition}`);
  return rank;
}

export function sortPlanItems(items) {
  return [...items].sort((a, b) => {
    const aDisposition = a.disposition ?? (a.result_type === "publish_kn_and_carrier" ? "add" : a.result_type === "no_change" ? "no_change" : "candidate");
    const bDisposition = b.disposition ?? (b.result_type === "publish_kn_and_carrier" ? "add" : b.result_type === "no_change" ? "no_change" : "candidate");
    return (
      dispositionRank(aDisposition) - dispositionRank(bDisposition) ||
      a.observation_id.localeCompare(b.observation_id) ||
      String(a.target_kn_id ?? "").localeCompare(String(b.target_kn_id ?? "")) ||
      String(a.carrier?.artifact_id ?? "").localeCompare(String(b.carrier?.artifact_id ?? ""))
    );
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalizePlan(plan) {
  return canonicalValue({ ...plan, items: sortPlanItems(plan.items) });
}

export function digestPlan(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizePlan(plan))).digest("hex");
}
