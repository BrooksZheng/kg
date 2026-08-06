// Shared version and field-shape resolution for the evaluators.
//
// D68, D71 and D72 were the same defect: a writer moved to version N+1 while
// a reader kept a literal `version !== 1`, and the saved fixtures — frozen at
// the old version — kept the suite green. KN-0034 puts the version table in
// the schema; this module is the single place that reads it, so a bump lands
// in every evaluator at once (KN-0045).
//
// A schema declares its current shape with `product_version` and `field_order`,
// and any still-accepted older shape with `legacy_versions` plus the
// `legacy_*` field orders. A schema with no `legacy_versions` accepts only its
// current version.

function splitOrder(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty pipe-separated field order`);
  }
  return value.split("|");
}

function currentVersion(schema, label) {
  const version = schema.product_version ?? schema.version;
  if (!Number.isInteger(version)) {
    throw new Error(`${label} declares no integer product_version`);
  }
  return version;
}

export function acceptedVersions(schema, label = "schema") {
  const current = currentVersion(schema, label);
  const legacy = schema.legacy_versions ?? [];
  if (!Array.isArray(legacy)) {
    throw new Error(`${label} legacy_versions must be a list`);
  }
  for (const value of legacy) {
    if (!Number.isInteger(value)) throw new Error(`${label} legacy_versions holds a non-integer`);
    if (value >= current) throw new Error(`${label} legacy_versions holds ${value}, not older than ${current}`);
  }
  return [current, ...legacy];
}

export function assertAcceptedVersion(record, schema, label) {
  const accepted = acceptedVersions(schema, label);
  if (!accepted.includes(record?.version)) {
    throw new Error(`${label} version ${record?.version} is not one of ${accepted.join(", ")}`);
  }
  return record.version;
}

// Field order for a given accepted version. The current version uses
// `field_order`; an accepted legacy version uses `legacy_field_order`.
export function fieldOrderForVersion(schema, version, label = "schema") {
  const current = currentVersion(schema, label);
  if (version === current) {
    if (!Array.isArray(schema.field_order)) throw new Error(`${label} declares no field_order`);
    return [...schema.field_order];
  }
  if (!acceptedVersions(schema, label).includes(version)) {
    throw new Error(`${label} version ${version} is not accepted`);
  }
  return splitOrder(schema.legacy_field_order, `${label} legacy_field_order`);
}

export function recordFieldOrderForVersion(schema, version, record, label = "schema") {
  const current = currentVersion(schema, label);
  const table = version === current ? schema.record_field_order : schema.legacy_record_field_order;
  if (!table || typeof table[record] !== "string") {
    throw new Error(`${label} declares no record field order for ${record} at version ${version}`);
  }
  return splitOrder(table[record], `${label} record_field_order.${record}`);
}

// The kickoff index renamed its harness-edge list to `edges` at version 2.
// Readers ask for the list rather than a field name so a rename lands in one
// place (KN-0045); the name itself comes from the version's field order.
export function indexEdgeList(index, schema, label = "kg.kickoff_context_index") {
  const version = assertAcceptedVersion(index, schema, label);
  const order = fieldOrderForVersion(schema, version, label);
  const field = order.includes("edges") ? "edges" : order.includes("harness") ? "harness" : null;
  if (field === null) throw new Error(`${label} version ${version} declares no harness edge list`);
  const value = index[field];
  if (!Array.isArray(value)) throw new Error(`${label}.${field} must be a list`);
  return value;
}

// Version 1 index entries carried a knowledge entry's claim and scope at the
// top level; version 2 moved them under `metadata`. Readers ask for the
// summary rather than a field path so the next relocation is one edit.
export function entryKnowledgeSummary(entry, schema, label = "kg.kickoff_context_index") {
  void label;
  void schema;
  const nested = entry?.metadata;
  const source = nested && typeof nested === "object" && !Array.isArray(nested) && "claim" in nested ? nested : entry;
  return { claim: source?.claim, scope: source?.scope };
}
