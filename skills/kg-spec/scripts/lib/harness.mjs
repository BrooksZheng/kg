// Deterministic helpers for compile contexts and managed Markdown carriers.
// All filesystem identity and containment checks delegate to host.mjs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";
import * as kyaml from "./kyaml.mjs";
import * as protocol from "./protocol.mjs";

const CONTEXT_FIELDS = [
  "kind",
  "version",
  "generated_at",
  "host_root",
  "observations",
  "knowledge_entries",
  "accepted_documents",
  "artifacts",
  "context_digest",
];
const INPUT_FIELDS = ["id", "path", "sha256"];
const ARTIFACT_FIELDS = [
  "artifact_id",
  "sidecar_path",
  "target_path",
  "ownership",
  "update_policy",
  "content_hash",
  "sha256",
  "target_sha256",
];
const MANAGED_MARKER_RE = /<!-- kg:managed (HAR-[A-Z0-9][A-Z0-9._-]*) (begin|end) -->/g;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function contentHash(content) {
  return `sha256:${sha256(Buffer.from(normalizeManagedContent(content), "utf8"))}`;
}

export function normalizeManagedContent(content) {
  const normalized = String(content)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return normalized === "" ? "" : `${normalized}\n`;
}

export function managedMarkers(artifactId) {
  if (!/^HAR-[A-Z0-9][A-Z0-9._-]*$/.test(artifactId)) {
    throw new Error(`invalid harness artifact id: ${artifactId}`);
  }
  return {
    begin: `<!-- kg:managed ${artifactId} begin -->`,
    end: `<!-- kg:managed ${artifactId} end -->`,
  };
}

export function inspectManagedBlock(documentText, artifactId) {
  const text = String(documentText).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const markers = [...text.matchAll(MANAGED_MARKER_RE)].map((match) => ({
    artifactId: match[1],
    side: match[2],
    index: match.index,
    text: match[0],
  }));
  const own = markers.filter((marker) => marker.artifactId === artifactId);
  if (own.length === 0) {
    const found = [...new Set(markers.map((marker) => marker.artifactId))];
    throw new Error(
      found.length
        ? `managed marker artifact id mismatch for ${artifactId}; found ${found.join(", ")}`
        : `managed markers missing for ${artifactId}`,
    );
  }
  if (own.filter((marker) => marker.side === "begin").length !== 1) {
    throw new Error(`managed begin marker must appear exactly once for ${artifactId}`);
  }
  if (own.filter((marker) => marker.side === "end").length !== 1) {
    throw new Error(`managed end marker must appear exactly once for ${artifactId}`);
  }
  if (markers.length !== 2) {
    throw new Error(`M2 target must contain exactly one managed marker pair; found ${markers.length} markers`);
  }
  const begin = own.find((marker) => marker.side === "begin");
  const end = own.find((marker) => marker.side === "end");
  if (begin.index >= end.index) throw new Error(`managed markers are nested or out of order for ${artifactId}`);
  const innerStart = begin.index + begin.text.length;
  const rawBetween = text.slice(innerStart, end.index);
  if (!rawBetween.startsWith("\n") || !rawBetween.endsWith("\n")) {
    throw new Error(`managed markers for ${artifactId} must each occupy their own line`);
  }
  const rawContent = rawBetween.slice(1, -1);
  const canonicalContent = normalizeManagedContent(rawContent);
  return {
    artifactId,
    begin,
    end,
    rawContent,
    canonicalContent,
    contentHash: contentHash(canonicalContent),
    prefix: text.slice(0, innerStart + 1),
    suffix: text.slice(end.index),
    outsideHash: sha256(Buffer.from(`${text.slice(0, innerStart)}\n<kg:managed-content>\n${text.slice(end.index)}`, "utf8")),
  };
}

export function replaceManagedBlock(documentText, artifactId, content) {
  const inspected = inspectManagedBlock(documentText, artifactId);
  return `${inspected.prefix}${normalizeManagedContent(content)}${inspected.suffix}`;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactFields(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function resolveTrustedHostPath(root, relative, { mustExist = true } = {}) {
  if (typeof relative !== "string" || relative.trim() === "" || path.isAbsolute(relative)) {
    throw new Error(`path must be a non-empty relative path: ${relative}`);
  }
  const portable = relative.replaceAll("\\", "/");
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new Error(`path escapes root: ${relative}`);
  const target = path.resolve(root, ...segments);
  if (host.isOutside(root, target)) throw new Error(`path escapes root: ${relative}`);
  let current = host.canonicalPath(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`path contains a symbolic link: ${relative}`);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      throw error;
    }
  }
  const canonicalTarget = host.canonicalPath(target);
  if (host.isOutside(root, canonicalTarget)) throw new Error(`path resolves outside root: ${relative}`);
  if (mustExist && !fs.existsSync(target)) throw new Error(`path does not exist: ${relative}`);
  return { full: target, relative: segments.join("/"), canonical: canonicalTarget };
}

function listRecursiveFiles(root, directory, extension) {
  if (!fs.existsSync(directory)) return [];
  const out = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`compile input must not be a symbolic link: ${portableRelative(root, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
    }
  }
  walk(directory);
  return out;
}

function fileInput(root, file, id) {
  return {
    id,
    path: portableRelative(root, file),
    sha256: sha256(fs.readFileSync(file)),
  };
}

function loadObservation(root, file) {
  const record = kyaml.parse(fs.readFileSync(file, "utf8"));
  const errors = protocol.validateRecord(record, protocol.loadObservationSchema());
  const basename = path.basename(file, ".yaml");
  if (record.id !== basename) errors.push(`observation id must equal filename ${basename}`);
  if (record.compiled_to_kn !== undefined && record.compiled_to_kn !== null) {
    errors.push("pending observation must not contain compiled_to_kn");
  }
  if (errors.length) throw new Error(`invalid pending observation ${basename}: ${errors.join("; ")}`);
  return fileInput(root, file, record.id);
}

function loadKnowledgeEntry(root, file) {
  const { frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
  const errors = protocol.validateRecord(frontmatter, protocol.loadKnowledgeSchema());
  if (body.trim() === "") errors.push("knowledge body is empty");
  if (!new RegExp(`^${frontmatter.id}(-[a-z0-9-]+)?\\.md$`).test(path.basename(file))) {
    errors.push(`knowledge filename must start with ${frontmatter.id}`);
  }
  if (errors.length) throw new Error(`invalid knowledge entry ${path.basename(file)}: ${errors.join("; ")}`);
  return fileInput(root, file, frontmatter.id);
}

function loadAcceptedDocument(root, file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return null;
  let frontmatter, body;
  try {
    ({ frontmatter, body } = protocol.splitFrontmatter(text));
  } catch (error) {
    if (/^kind:[ ]+kg\.project_document[ ]*$/m.test(text.split(/\r?\n/).slice(0, 30).join("\n"))) {
      throw new Error(`registered project document ${portableRelative(root, file)} is invalid: ${error.message}`);
    }
    return null;
  }
  if (frontmatter.kind !== "kg.project_document") return null;
  const errors = protocol.validateRecord(frontmatter, protocol.loadProjectDocumentSchema());
  if (body.trim() === "") errors.push("document body is empty");
  if (frontmatter.status === "accepted" && !frontmatter.accepted_at) errors.push("accepted_at is required");
  if (errors.length) {
    throw new Error(`registered project document ${portableRelative(root, file)} is invalid: ${errors.join("; ")}`);
  }
  return frontmatter.status === "accepted" ? fileInput(root, file, frontmatter.title) : null;
}

export function readHarnessSidecar(root, file) {
  const record = kyaml.parse(fs.readFileSync(file, "utf8"));
  const errors = protocol.validateRecord(record, protocol.loadHarnessSchema());
  if (path.basename(file) !== `${record.artifact_id}.yaml`) {
    errors.push(`sidecar filename must be ${record.artifact_id}.yaml`);
  }
  if (errors.length) throw new Error(`invalid harness sidecar ${path.basename(file)}: ${errors.join("; ")}`);
  return record;
}

function resolveSourceRef(root, ref) {
  const relative = String(ref).replace(/#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/, "");
  return host.resolveSafeRelative(root, relative);
}

export function validateHarnessReferences(root, record) {
  for (const ref of record.source_refs) {
    try {
      resolveSourceRef(root, ref);
    } catch (error) {
      throw new Error(`harness source_ref ${ref} is invalid: ${error.message}`);
    }
  }
}

export function canonicalHarnessRecord(record) {
  return {
    artifact_id: record.artifact_id,
    type: record.type,
    path: record.path,
    ownership: record.ownership,
    status: record.status,
    source_kn_ids: record.source_kn_ids,
    source_refs: record.source_refs,
    content_hash: record.content_hash,
    generator_version: record.generator_version,
    last_verified: record.last_verified,
    update_policy: record.update_policy,
  };
}

export function renderHarnessSidecar(record) {
  const canonical = canonicalHarnessRecord(record);
  const errors = protocol.validateRecord(canonical, protocol.loadHarnessSchema());
  if (errors.length) throw new Error(`harness record is invalid: ${errors.join("; ")}`);
  return kyaml.stringify(canonical);
}

function loadArtifact(root, file) {
  const record = readHarnessSidecar(root, file);
  validateHarnessReferences(root, record);
  const target = host.resolveSafeRelative(root, record.path);
  if (path.extname(target.full).toLowerCase() !== ".md") {
    throw new Error(`M2 harness target must be Markdown: ${record.path}`);
  }
  const targetText = fs.readFileSync(target.full, "utf8");
  const block = inspectManagedBlock(targetText, record.artifact_id);
  if (block.contentHash !== record.content_hash) {
    throw new Error(
      `harness content_hash mismatch for ${record.artifact_id}: sidecar ${record.content_hash}, block ${block.contentHash}`,
    );
  }
  return {
    artifact_id: record.artifact_id,
    sidecar_path: portableRelative(root, file),
    target_path: target.relative,
    ownership: record.ownership,
    update_policy: record.update_policy,
    content_hash: record.content_hash,
    sha256: sha256(fs.readFileSync(file)),
    target_sha256: sha256(fs.readFileSync(target.full)),
  };
}

function contextWithoutDigest(context) {
  const { context_digest: _ignored, ...rest } = context;
  return rest;
}

export function digestContext(context) {
  return sha256(Buffer.from(JSON.stringify(contextWithoutDigest(context)), "utf8"));
}

export function buildCompileContext(rootValue, options = {}) {
  const root = host.assertSafeHostRoot(rootValue);
  const paths = host.kgPaths(root);
  if (!fs.existsSync(paths.kg)) throw new Error(`.kg/ not found under ${root}`);
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid compile context timestamp: ${options.now}`);

  const observationFiles = host.listFiles(paths.observations, ".yaml");
  const knowledgeFiles = host.listFiles(paths.knowledge, ".md");
  const docsRoot = path.join(root, "docs");
  const documentFiles = listRecursiveFiles(root, docsRoot, ".md");
  const artifactsRoot = path.join(root, "harness", "artifacts");
  const artifactFiles = host.listFiles(artifactsRoot, ".yaml");

  const context = {
    kind: "kg.compile_context",
    version: 1,
    generated_at: now.toISOString(),
    host_root: host.canonicalPath(root),
    observations: observationFiles.map((file) => loadObservation(root, file)),
    knowledge_entries: knowledgeFiles.map((file) => loadKnowledgeEntry(root, file)),
    accepted_documents: documentFiles.map((file) => loadAcceptedDocument(root, file)).filter(Boolean),
    artifacts: artifactFiles.map((file) => loadArtifact(root, file)),
  };
  return { ...context, context_digest: digestContext(context) };
}

export function validateCompileContext(context) {
  assertExactFields(context, CONTEXT_FIELDS, "compile context");
  if (context.kind !== "kg.compile_context" || context.version !== 1) {
    throw new Error("compile context kind/version is invalid");
  }
  if (typeof context.generated_at !== "string" || Number.isNaN(new Date(context.generated_at).getTime())) {
    throw new Error("compile context generated_at is invalid");
  }
  if (typeof context.host_root !== "string" || context.host_root.trim() === "") {
    throw new Error("compile context host_root is required");
  }
  for (const field of ["observations", "knowledge_entries", "accepted_documents"]) {
    if (!Array.isArray(context[field])) throw new Error(`compile context ${field} must be an array`);
    for (const [index, item] of context[field].entries()) {
      assertExactFields(item, INPUT_FIELDS, `compile context ${field}[${index}]`);
      if (!item.id || !item.path || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw new Error(`compile context ${field}[${index}] is invalid`);
      }
    }
  }
  if (!Array.isArray(context.artifacts)) throw new Error("compile context artifacts must be an array");
  for (const [index, item] of context.artifacts.entries()) {
    assertExactFields(item, ARTIFACT_FIELDS, `compile context artifacts[${index}]`);
    if (!/^HAR-/.test(item.artifact_id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-f0-9]{64}$/.test(item.target_sha256)) {
      throw new Error(`compile context artifacts[${index}] is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(context.context_digest) || digestContext(context) !== context.context_digest) {
    throw new Error("compile context digest is invalid");
  }
  return context;
}

export function assertCompileContextCurrent(rootValue, context) {
  validateCompileContext(context);
  const root = host.assertSafeHostRoot(rootValue);
  if (host.canonicalPath(root) !== host.canonicalPath(context.host_root)) {
    throw new Error("compile context belongs to a different host root");
  }
  const current = buildCompileContext(root, { now: context.generated_at });
  if (JSON.stringify(current) !== JSON.stringify(context)) {
    const groups = ["observations", "knowledge_entries", "accepted_documents", "artifacts"];
    const drifted = groups.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(context[field]));
    throw new Error(`compile inputs changed after context generation: ${drifted.join(", ") || "context metadata"}`);
  }
  return current;
}

export function resolveCompileInput(root, relative, options = {}) {
  return resolveTrustedHostPath(host.assertSafeHostRoot(root), relative, options);
}
