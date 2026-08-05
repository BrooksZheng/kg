// Shared validation for the isolated agent-assisted scan product.
// Deterministic scan entrypoints never import this module.

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { documentAnchor, host, machineContract, protocol } from "./_lib.mjs";

const AGENT_SCHEMA = protocol.loadScanAgentReportSchema();
const PACKET_FIELDS = String(AGENT_SCHEMA.evidence_packet_field_order).split("|");
const SOURCE_FIELDS = String(AGENT_SCHEMA.evidence_source_field_order).split("|");
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactOrder(value, fields, label) {
  assertObject(value, label);
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(fields)) {
    throw new Error(`${label} fields must follow protocol order: ${fields.join(", ")}`);
  }
}

function safeExistingFile(value, label) {
  const declared = path.resolve(value);
  const canonical = host.canonicalPath(declared);
  if (host.hasPathSegment(declared, ".kg") || host.hasPathSegment(canonical, ".kg")) {
    throw new Error(`${label} must not enter .kg`);
  }
  if (!fs.existsSync(declared) || !fs.statSync(declared).isFile()) {
    throw new Error(`${label} is not a file: ${declared}`);
  }
  if (fs.lstatSync(declared).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return { declared, canonical };
}

export function readStrictJsonFile(value, label) {
  const file = safeExistingFile(value, label);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file.declared, "utf8"));
  } catch (error) {
    throw new Error(`${label} must be strict JSON: ${error.message}`);
  }
  return { ...file, record };
}

export function outputFile(value, label, extensions = [".json", ".yaml"], projectRoot = null) {
  const file = path.resolve(value);
  const canonical = host.canonicalPath(file);
  if (!extensions.includes(path.extname(file).toLowerCase())) {
    throw new Error(`${label} must use ${extensions.join(" or ")}`);
  }
  if (host.hasPathSegment(file, ".kg") || host.hasPathSegment(canonical, ".kg")) {
    throw new Error(`${label} must not enter .kg`);
  }
  if (projectRoot !== null) {
    const root = host.assertSafeHostRoot(projectRoot);
    if (!host.isOutside(root, canonical)) throw new Error(`${label} output must be outside project root`);
  }
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${label}: ${file}`);
  return file;
}

function lineCount(bytes) {
  const text = bytes.toString("utf8");
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return /(?:\r\n|\r|\n)$/.test(text) ? lines.length - 1 : lines.length;
}

function sourceSnapshot(projectRoot, sourcePath) {
  const resolved = machineContract.resolveCanonicalPath(projectRoot, sourcePath);
  if (resolved.relative !== sourcePath) throw new Error(`source path is not canonical: ${sourcePath}`);
  if (!fs.statSync(resolved.full).isFile()) throw new Error(`source path is not a file: ${sourcePath}`);
  const bytes = fs.readFileSync(resolved.full);
  let content;
  try {
    content = UTF8.decode(bytes);
  } catch {
    throw new Error(`source path is not valid UTF-8 text: ${sourcePath}`);
  }
  return machineContract.orderRecordByProtocol({
    path: resolved.relative,
    sha256: machineContract.sha256Bytes(bytes),
    line_count: lineCount(bytes),
    content,
  }, SOURCE_FIELDS);
}

export function readBaseReport(value) {
  const base = readStrictJsonFile(value, "base report");
  const schema = protocol.loadScanReportSchema();
  const errors = protocol.validateRecord(base.record, schema);
  if (errors.length > 0) throw new Error(`base report is invalid: ${errors.join("; ")}`);
  assertExactOrder(base.record, schema.field_order, "base report");
  for (const [index, finding] of base.record.findings.entries()) {
    assertExactOrder(finding, schema.finding_field_order, `base report findings[${index}]`);
    if (finding.detection_mode !== "deterministic") {
      throw new Error(`base report findings[${index}] is not deterministic`);
    }
  }
  return { ...base, sha256: machineContract.sha256File(base.declared) };
}

export function buildEvidencePacket({ projectRoot, baseReport, sourcePaths }) {
  const root = host.assertSafeHostRoot(projectRoot);
  const base = readBaseReport(baseReport);
  const uniquePaths = [...new Set(sourcePaths)];
  if (uniquePaths.length !== sourcePaths.length) throw new Error("evidence sources must not contain duplicates");
  if (uniquePaths.length === 0) throw new Error("evidence packet needs at least one source");
  const sources = uniquePaths.map((sourcePath) => sourceSnapshot(root, sourcePath))
    .sort((left, right) => left.path.localeCompare(right.path));
  return machineContract.orderRecordByProtocol({
    version: AGENT_SCHEMA.evidence_packet_version,
    project_root: root,
    base_report_path: base.canonical,
    base_report_sha256: base.sha256,
    sources,
  }, PACKET_FIELDS);
}

export function validateEvidencePacket({ packet, projectRoot, baseReport }) {
  const root = host.assertSafeHostRoot(projectRoot);
  const base = readBaseReport(baseReport);
  assertExactOrder(packet.record, PACKET_FIELDS, "evidence packet");
  if (packet.record.version !== AGENT_SCHEMA.evidence_packet_version) {
    throw new Error(`evidence packet version must be ${AGENT_SCHEMA.evidence_packet_version}`);
  }
  if (packet.record.project_root !== root) throw new Error("evidence packet project_root is not canonical or differs from --project-root");
  if (packet.record.base_report_path !== base.canonical) throw new Error("evidence packet base report path differs from --base-report");
  if (packet.record.base_report_sha256 !== base.sha256) throw new Error("evidence packet base report hash differs from disk bytes");
  if (!Array.isArray(packet.record.sources) || packet.record.sources.length === 0) {
    throw new Error("evidence packet needs a non-empty sources list");
  }
  const paths = packet.record.sources.map((source) => source?.path);
  if (new Set(paths).size !== paths.length) throw new Error("evidence packet source paths must be unique");
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort((left, right) => left.localeCompare(right)))) {
    throw new Error("evidence packet sources must be sorted by canonical path");
  }
  const sources = new Map();
  for (const [index, source] of packet.record.sources.entries()) {
    assertExactOrder(source, SOURCE_FIELDS, `evidence packet sources[${index}]`);
    const observed = sourceSnapshot(root, source.path);
    if (JSON.stringify(source) !== JSON.stringify(observed)) {
      throw new Error(`evidence packet source differs from disk bytes: ${source.path}`);
    }
    sources.set(source.path, observed);
  }
  return { root, base, sources, packetSha256: machineContract.sha256File(packet.declared) };
}

export function parseStableSourceRef(sourceRef) {
  return documentAnchor.parseStableLineAnchor(sourceRef, AGENT_SCHEMA);
}

export function validatePacketSourceRef(sourceRef, packetSources) {
  const parsed = parseStableSourceRef(sourceRef);
  const source = packetSources.get(parsed.path);
  if (!source) throw new Error(`source ref is outside evidence packet membership: ${sourceRef}`);
  if (parsed.lineEnd > source.line_count) {
    throw new Error(`source ref line range exceeds packet source bytes: ${sourceRef}`);
  }
  return parsed;
}

export function validateAgentFindings(findings, packetState) {
  const semanticGap = AGENT_SCHEMA.semantic_gap_issue_code;
  const structuralIssues = new Set(Object.values(protocol.loadScanPolicy().structural_coverage));
  for (const [index, finding] of findings.entries()) {
    for (const sourceRef of finding.source_refs) validatePacketSourceRef(sourceRef, packetState.sources);
    if (finding.type === "semantic_contradiction") {
      if (finding.source_refs.length < 2) throw new Error(`findings[${index}] contradiction needs two distinct source refs`);
      if (finding.module_identity !== null || finding.coverage_evidence.length !== 0 || finding.missing_evidence.length !== 0) {
        throw new Error(`findings[${index}] contradiction must not carry semantic gap fields`);
      }
      continue;
    }
    if (finding.type !== semanticGap) throw new Error(`findings[${index}] has an unsupported semantic type`);
    const module = machineContract.resolveCanonicalPath(packetState.root, finding.module_identity);
    if (module.relative !== finding.module_identity) throw new Error(`findings[${index}] module_identity is not canonical`);
    if (finding.coverage_evidence.length === 0 || finding.missing_evidence.length === 0) {
      throw new Error(`findings[${index}] semantic gap needs coverage_evidence and missing_evidence`);
    }
    for (const sourceRef of finding.coverage_evidence) {
      validatePacketSourceRef(sourceRef, packetState.sources);
      if (!finding.source_refs.includes(sourceRef)) {
        throw new Error(`findings[${index}] coverage_evidence must also appear in source_refs`);
      }
    }
    for (const missing of finding.missing_evidence) {
      if (structuralIssues.has(missing)) {
        throw new Error(`findings[${index}] semantic gap repeats a deterministic structural issue code`);
      }
    }
  }
}

export function normalizeAgentFindings(findings) {
  return findings.map((finding) => ({
    ...finding,
    source_refs: finding.source_refs.map((sourceRef) =>
      documentAnchor.normalizeStableLineAnchor(sourceRef, AGENT_SCHEMA)),
    coverage_evidence: finding.coverage_evidence.map((sourceRef) =>
      documentAnchor.normalizeStableLineAnchor(sourceRef, AGENT_SCHEMA)),
  }));
}

export { AGENT_SCHEMA, PACKET_FIELDS, SOURCE_FIELDS };
