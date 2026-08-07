// Protocol-driven raw input validation and canonical product construction.
// Product field tables and script ownership live in protocol files under
// KN-0034. This module interprets those tables without declaring a second copy.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";
import * as kyaml from "./kyaml.mjs";
import { validateRecord } from "./protocol.mjs";

function listValue(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").split("|").filter(Boolean);
}

function ownedFields(schema) {
  return new Set(listValue(schema.script_owned_fields));
}

function visitPaths(value, prefix, callback) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visitPaths(item, `${prefix}[]`, callback);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const current = prefix === "" ? key : `${prefix}.${key}`;
    callback(current);
    visitPaths(child, current, callback);
  }
}

function rawSchema(schema) {
  const owned = ownedFields(schema);
  const fields = Object.fromEntries(
    Object.entries(schema.fields ?? {}).filter(([field]) => !owned.has(field)),
  );
  return { ...schema, fields };
}

export function validateRawInput(raw, schema) {
  const errors = [];
  const owned = ownedFields(schema);
  visitPaths(raw, "", (field) => {
    if (owned.has(field)) errors.push(`${field}: script-owned field`);
  });
  errors.push(...validateRecord(raw, rawSchema(schema)));
  return [...new Set(errors)];
}

export function assertRawInput(raw, schema, label = "raw input") {
  const errors = validateRawInput(raw, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid:\n  ${errors.join("\n  ")}`);
  return raw;
}

function orderedRecord(record, order) {
  const output = {};
  for (const field of order) {
    if (Object.prototype.hasOwnProperty.call(record, field)) output[field] = record[field];
  }
  return output;
}

function canonicalNested(record, schema) {
  const output = { ...record };
  for (const [container, orderValue] of Object.entries(schema.record_field_order ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(output, container)) continue;
    const order = listValue(orderValue);
    if (Array.isArray(output[container])) {
      output[container] = output[container].map((item) => orderedRecord(item, order));
    } else if (output[container] !== null && typeof output[container] === "object") {
      output[container] = orderedRecord(output[container], order);
    }
  }
  return output;
}

export function orderRecordByProtocol(record, fieldOrder, recordFieldOrder = {}) {
  return orderedRecord(
    canonicalNested(record, { record_field_order: recordFieldOrder }),
    listValue(fieldOrder),
  );
}

export function canonicalizeRecord(record, schema, label = "machine product") {
  const errors = validateRecord(record, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid:\n  ${errors.join("\n  ")}`);
  return orderRecordByProtocol(record, schema.field_order ?? [], schema.record_field_order ?? {});
}

function mergeRecords(raw, scriptValues) {
  const output = { ...raw };
  for (const [key, value] of Object.entries(scriptValues)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      output[key] !== null &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = mergeRecords(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function buildCanonicalRecord(raw, scriptValues, schema, label = "machine product") {
  assertRawInput(raw, schema, `${label} raw input`);
  return canonicalizeRecord(mergeRecords(raw, scriptValues), schema, label);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

export function sha256CanonicalJson(value) {
  return sha256Bytes(canonicalJson(value));
}

export function resolveCanonicalPath(root, relative, options = {}) {
  return host.resolveSafeRelative(root, relative, {
    mustExist: options.mustExist ?? true,
    allowSymlink: false,
    forbidKg: true,
  });
}

export function canonicalFileIdentity(root, relative) {
  const resolved = resolveCanonicalPath(root, relative);
  if (!fs.statSync(resolved.full).isFile()) throw new Error(`path is not a file: ${relative}`);
  return {
    path: resolved.relative,
    canonical_path: resolved.canonical,
    sha256: sha256File(resolved.full),
  };
}

export function writeCanonicalRecord(file, record, schema, options = {}) {
  const canonical = canonicalizeRecord(record, schema, options.label);
  const output = path.resolve(file);
  if (host.hasPathSegment(output, ".kg")) throw new Error("machine product output must not enter .kg");
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite machine product: ${output}`);
  const extension = path.extname(output).toLowerCase();
  if (![".json", ".yaml"].includes(extension)) throw new Error("machine product output must use .json or .yaml");
  const content = extension === ".json"
    ? `${JSON.stringify(canonical, null, 2)}\n`
    : kyaml.stringify(canonical);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content, { flag: "wx" });
  return { record: canonical, file: output, sha256: sha256Bytes(content) };
}
