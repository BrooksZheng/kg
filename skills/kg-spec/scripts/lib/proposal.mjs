// Deterministic parser for content-addressed carrier proposal manifests.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";
import * as kyaml from "./kyaml.mjs";
import * as protocol from "./protocol.mjs";

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (JSON.stringify(actual) !== JSON.stringify(fields)) {
    throw new Error(`${label} fields must follow protocol order: ${fields.join(", ")}`);
  }
}

function safeRelative(value, label) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const segments = value.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw new Error(`${label} escapes the host root`);
  if (segments.some((segment) => segment.toLowerCase() === ".kg")) throw new Error(`${label} enters .kg`);
  return segments.join("/");
}

function canonicalPayload(manifest) {
  return {
    carrier_type: manifest.carrier_type,
    target_path: manifest.target_path,
    target_sha256: manifest.target_sha256,
    candidate_path: manifest.candidate_path,
    candidate_sha256: manifest.candidate_sha256,
    source_kn_ids: [...manifest.source_kn_ids].sort(),
    source_refs: [...manifest.source_refs].sort(),
    generator_version: manifest.generator_version,
  };
}

export function proposalManifestDigest(manifest) {
  return sha256(Buffer.from(JSON.stringify(canonicalPayload(manifest)), "utf8"));
}

export function canonicalProposalManifest(manifest) {
  return {
    kind: manifest.kind,
    version: manifest.version,
    proposal_id: manifest.proposal_id,
    carrier_type: manifest.carrier_type,
    target_path: manifest.target_path,
    target_sha256: manifest.target_sha256,
    candidate_path: manifest.candidate_path,
    candidate_sha256: manifest.candidate_sha256,
    source_kn_ids: manifest.source_kn_ids,
    source_refs: manifest.source_refs,
    generator_version: manifest.generator_version,
    status: manifest.status,
  };
}

function readManifestInput(input) {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return { value: input, bytes: null, file: null };
  }
  const file = path.resolve(String(input));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`proposal manifest does not exist: ${file}`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`proposal manifest must not be a symbolic link: ${file}`);
  const bytes = fs.readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`proposal manifest is not valid JSON: ${error.message}`);
  }
  return { value, bytes, file };
}

export function parseProposalManifest(input, options = {}) {
  const loaded = readManifestInput(input);
  const schema = protocol.loadProposalManifestSchema();
  const fieldOrder = schema.field_order;
  exactFields(loaded.value, fieldOrder, "proposal manifest");
  const errors = protocol.validateRecord(loaded.value, schema);
  if (errors.length) throw new Error(`invalid proposal manifest: ${errors.join("; ")}`);
  const manifest = canonicalProposalManifest(loaded.value);
  safeRelative(manifest.candidate_path, "candidate_path");
  if (manifest.target_path !== null) safeRelative(manifest.target_path, "target_path");
  if (manifest.target_path === null && manifest.target_sha256 !== null) {
    throw new Error("target_sha256 must be null when target_path is null");
  }
  if (manifest.target_path !== null && !HASH_RE.test(manifest.target_sha256)) {
    throw new Error("target_sha256 is required when target_path is present");
  }
  const expectedProposalId = `compile-${proposalManifestDigest(manifest).slice(0, 16)}`;
  if (options.verifyIdentity !== false && manifest.proposal_id !== expectedProposalId) {
    throw new Error(`proposal_id does not match canonical manifest digest; expected ${expectedProposalId}`);
  }

  let candidateFile = null;
  let targetFile = null;
  if (options.root) {
    const root = host.assertSafeHostRoot(options.root);
    candidateFile = host.resolveSafeRelative(root, manifest.candidate_path);
    const candidateHash = `sha256:${sha256(fs.readFileSync(candidateFile.full))}`;
    if (candidateHash !== manifest.candidate_sha256) {
      throw new Error(`candidate hash mismatch: ${manifest.candidate_path}`);
    }
    if (manifest.target_path !== null) {
      targetFile = host.resolveSafeRelative(root, manifest.target_path);
      const targetHash = `sha256:${sha256(fs.readFileSync(targetFile.full))}`;
      if (targetHash !== manifest.target_sha256) throw new Error(`target hash mismatch: ${manifest.target_path}`);
    }
  }
  return {
    manifest,
    manifest_sha256: loaded.bytes ? `sha256:${sha256(loaded.bytes)}` : null,
    canonical_digest: proposalManifestDigest(manifest),
    candidate_file: candidateFile?.relative ?? null,
    target_file: targetFile?.relative ?? null,
  };
}

export function renderProposalManifest(manifest) {
  const canonical = canonicalProposalManifest(manifest);
  const errors = protocol.validateRecord(canonical, protocol.loadProposalManifestSchema());
  if (errors.length) throw new Error(`invalid proposal manifest: ${errors.join("; ")}`);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function proposalManifestAsKyaml(manifest) {
  const canonical = canonicalProposalManifest(manifest);
  return kyaml.stringify(canonical);
}
