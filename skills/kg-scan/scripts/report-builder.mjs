// Deterministic R4.3 scan report builder.
//
// This module is deliberately read-only. It never enters .kg, follows a
// symlink, or executes a host file. check-staleness.mjs and health-check.mjs
// are thin entrypoints over this same builder.

import fs from "node:fs";
import path from "node:path";
import { harness, host, inverseMap, kyaml, proposal, protocol } from "./_lib.mjs";

const SCAN_REPORT_SCHEMA = protocol.loadScanReportSchema();
const REPORT_FIELDS = SCAN_REPORT_SCHEMA.field_order;
const FINDING_FIELDS = SCAN_REPORT_SCHEMA.finding_field_order;
function portableRelative(root, full) {
  return path.relative(root, full).split(path.sep).join("/");
}

function addFinding(findings, fields) {
  findings.push({
    detection_mode: "deterministic",
    artifact_id: fields.artifact_id ?? null,
    source_ref: fields.source_ref ?? null,
    issue: fields.issue,
    severity: fields.severity ?? "error",
    side: fields.side ?? "scan",
    kn_id: fields.kn_id ?? null,
    carrier_ref: fields.carrier_ref ?? null,
    source_path: fields.source_path ?? null,
    line_start: fields.line_start ?? null,
    line_end: fields.line_end ?? null,
    expected: fields.expected ?? null,
    actual: fields.actual ?? null,
    message: fields.message ?? null,
  });
}

function pathIssue(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes(".kg")) return "isolated_path";
  if (message.includes("symbolic link")) return "symlink_path";
  if (message.includes("escape") || message.includes("outside")) return "path_escape";
  return "path_invalid";
}

function safePath(root, relative, findings, fields, { mustExist = false } = {}) {
  try {
    return host.resolveSafeRelative(root, relative, { mustExist });
  } catch (error) {
    addFinding(findings, {
      ...fields,
      issue: fields.issue ?? pathIssue(error),
      source_path: fields.source_path ?? (typeof relative === "string" ? relative : null),
      message: error.message,
    });
    return null;
  }
}

function lineCount(bytes) {
  const text = bytes.toString("utf8");
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return /(?:\r\n|\r|\n)$/.test(text) ? lines.length - 1 : lines.length;
}

function parseSourceRef(sourceRef) {
  if (typeof sourceRef !== "string") return null;
  const match = /^(.*)#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(sourceRef);
  if (!match || !match[1]) return null;
  return {
    path: match[1],
    line_start: Number.parseInt(match[2], 10),
    line_end: Number.parseInt(match[3] ?? match[2], 10),
  };
}

function scanSourceRef(root, sourceRef, artifactId, findings, sourcePath) {
  const parsed = parseSourceRef(sourceRef);
  if (!parsed || parsed.line_end < parsed.line_start) {
    addFinding(findings, {
      artifact_id: artifactId,
      source_ref: sourceRef,
      issue: "line_anchor_invalid",
      side: "source",
      source_path: sourcePath,
      message: "source_ref must end in #Lstart or #Lstart-Lend with an ordered range",
    });
    return;
  }

  const resolved = safePath(root, parsed.path, findings, {
    artifact_id: artifactId,
    source_ref: sourceRef,
    side: "source",
    source_path: parsed.path,
    line_start: parsed.line_start,
    line_end: parsed.line_end,
  });
  if (!resolved) return;
  if (!fs.existsSync(resolved.full)) {
    addFinding(findings, {
      artifact_id: artifactId,
      source_ref: sourceRef,
      issue: "missing_source",
      severity: "error",
      side: "source",
      source_path: parsed.path,
      line_start: parsed.line_start,
      line_end: parsed.line_end,
    });
    return;
  }
  const stat = fs.statSync(resolved.full);
  if (!stat.isFile()) {
    addFinding(findings, {
      artifact_id: artifactId,
      source_ref: sourceRef,
      issue: "source_not_file",
      side: "source",
      source_path: parsed.path,
      line_start: parsed.line_start,
      line_end: parsed.line_end,
      actual: stat.isDirectory() ? "directory" : "non_file",
    });
    return;
  }
  const actualLines = lineCount(fs.readFileSync(resolved.full));
  if (parsed.line_end > actualLines) {
    addFinding(findings, {
      artifact_id: artifactId,
      source_ref: sourceRef,
      issue: "line_out_of_range",
      side: "source",
      source_path: parsed.path,
      line_start: parsed.line_start,
      line_end: parsed.line_end,
      expected: actualLines,
      actual: parsed.line_end,
      message: `source file has ${actualLines} line(s)`,
    });
  }
}

function listFiles(root, relativeDirectory, extension, findings, side) {
  const directory = safePath(root, relativeDirectory, findings, {
    issue: "scan_path_invalid",
    side,
    source_path: relativeDirectory,
  });
  if (!directory || !fs.existsSync(directory.full)) return [];
  if (!fs.statSync(directory.full).isDirectory()) {
    addFinding(findings, {
      issue: "scan_path_not_directory",
      side,
      source_path: relativeDirectory,
      actual: "file",
    });
    return [];
  }
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = portableRelative(root, full);
      if (entry.isSymbolicLink()) {
        addFinding(findings, {
          issue: "symlink_path",
          side,
          source_path: relative,
          message: "scan does not follow symlinks",
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === ".kg") {
          addFinding(findings, {
            issue: "isolated_path",
            side,
            source_path: relative,
            message: "scan does not read .kg paths, including mixed-case spellings",
          });
          continue;
        }
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push({ full, relative });
      }
    }
  }
  walk(directory.full);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function parseYamlFile(file) {
  return kyaml.parse(fs.readFileSync(file, "utf8"));
}

function validateSidecar(file, root, findings) {
  const relative = portableRelative(root, file.full);
  let record;
  try {
    record = parseYamlFile(file.full);
  } catch (error) {
    addFinding(findings, {
      issue: "schema_invalid",
      side: "sidecar",
      source_path: relative,
      message: error.message,
    });
    return null;
  }
  const artifactId = typeof record?.artifact_id === "string" ? record.artifact_id : null;
  const schema = protocol.loadHarnessSchema();
  const errors = protocol.validateRecord(record, schema);
  const expectedOrder = schema.field_order ?? [];
  if (errors.length === 0 && JSON.stringify(Object.keys(record)) !== JSON.stringify(expectedOrder)) {
    errors.push(`fields must follow protocol order: ${expectedOrder.join(", ")}`);
  }
  if (errors.length) {
    addFinding(findings, {
      artifact_id: artifactId,
      issue: "schema_invalid",
      side: "sidecar",
      source_path: relative,
      message: errors.join("; "),
    });
    return null;
  }
  if (path.basename(file.full) !== `${record.artifact_id}.yaml`) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "schema_invalid",
      side: "sidecar",
      source_path: relative,
      message: `sidecar filename must be ${record.artifact_id}.yaml`,
    });
    return null;
  }
  const region = protocol.loadRouting().ownership_update_matrix?.[record.ownership]?.[record.update_policy];
  if (region === undefined || region === "reject") {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "ownership_policy_invalid",
      side: "sidecar",
      source_path: relative,
      message: `${record.ownership}/${record.update_policy} is rejected by protocol routing`,
    });
    return null;
  }
  return { record, relative, file: file.full };
}

function validateKnowledgeFile(file, root, findings) {
  const relative = portableRelative(root, file.full);
  let frontmatter;
  let body;
  try {
    ({ frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(file.full, "utf8")));
  } catch (error) {
    addFinding(findings, {
      issue: "schema_invalid",
      side: "knowledge",
      source_path: relative,
      message: error.message,
    });
    return null;
  }
  const errors = protocol.validateRecord(frontmatter, protocol.loadKnowledgeSchema());
  if (!body.trim()) errors.push("knowledge body is empty");
  if (typeof frontmatter?.id === "string" && !new RegExp(`^${frontmatter.id}(-[a-z0-9-]+)?\\.md$`).test(path.basename(file.full))) {
    errors.push(`knowledge filename must start with ${frontmatter.id}`);
  }
  if (errors.length) {
    addFinding(findings, {
      artifact_id: null,
      kn_id: typeof frontmatter?.id === "string" ? frontmatter.id : null,
      issue: "schema_invalid",
      side: "knowledge",
      source_path: relative,
      message: errors.join("; "),
    });
    return null;
  }
  return { record: frontmatter, relative, file: file.full };
}

function compareHash(findings, artifact, issue, declared, observed, message) {
  if (declared !== observed) {
    addFinding(findings, {
      artifact_id: artifact.record.artifact_id,
      issue,
      side: "carrier",
      source_path: artifact.relative,
      expected: observed,
      actual: declared,
      message,
    });
  }
}

function validateCarrierTarget(root, artifact, findings) {
  const { record } = artifact;
  const target = safePath(root, record.path, findings, {
    artifact_id: record.artifact_id,
    issue: "carrier_path_invalid",
    side: "carrier",
    source_path: artifact.relative,
  });
  if (!target) return null;
  if (!fs.existsSync(target.full)) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "carrier_target_missing",
      side: "carrier",
      source_path: record.path,
    });
    return null;
  }
  if (!fs.statSync(target.full).isFile()) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "carrier_target_not_file",
      side: "carrier",
      source_path: record.path,
    });
    return null;
  }
  return target;
}

function validateCarrierHashes(root, artifact, findings) {
  const { record } = artifact;
  const target = validateCarrierTarget(root, artifact, findings);
  if (!target) return;

  // A human-owned carrier has no compile-owned bytes. Its required hash fields
  // remain metadata for the writer and are not treated as claims about a
  // machine segment that does not exist.
  if (record.type !== "markdown_document" || record.ownership === "human") return;

  let inspected;
  try {
    inspected = harness.inspectCarrier(fs.readFileSync(target.full), record.artifact_id, record.ownership);
  } catch (error) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "marker_invalid",
      side: "carrier",
      source_path: record.path,
      message: error.message,
    });
    return;
  }
  compareHash(findings, artifact, "content_hash_mismatch", record.content_hash, inspected.contentHash, "content hash differs from the inspected carrier bytes");
  compareHash(findings, artifact, "machine_segment_hash_mismatch", record.machine_segment_hash, inspected.machine_segment_hash, "machine segment hash differs from the inspected carrier bytes");
  compareHash(findings, artifact, "outside_hash_mismatch", record.outside_hash, inspected.outside_hash, "outside hash differs from the inspected carrier bytes");
}

function proposalManifestPath(candidatePath) {
  return path.posix.join(path.posix.dirname(candidatePath), "manifest.json");
}

function proposalIssue(message) {
  const lower = String(message).toLowerCase();
  if (lower.includes("target hash mismatch")) return "proposal_target_drift";
  if (lower.includes("candidate hash mismatch")) return "proposal_candidate_hash_mismatch";
  if (lower.includes("proposal_id does not match")) return "proposal_identity_mismatch";
  if (lower.includes("does not exist") && lower.includes("target")) return "proposal_target_drift";
  return "proposal_manifest_invalid";
}

function sortedValues(values) {
  return [...(values ?? [])].sort((a, b) => String(a).localeCompare(String(b)));
}

function validateProposal(root, artifact, findings) {
  const { record } = artifact;
  const needsProposal = record.status === "proposed" || record.proposal_id !== null || record.candidate_path !== null;
  if (!needsProposal) return;
  if (record.proposal_id === null || record.candidate_path === null) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "proposal_metadata_invalid",
      side: "proposal",
      source_path: artifact.relative,
      message: "proposed carriers require proposal_id and candidate_path",
    });
    return;
  }
  const candidate = safePath(root, record.candidate_path, findings, {
    artifact_id: record.artifact_id,
    issue: "proposal_candidate_path_invalid",
    side: "proposal",
    source_path: record.candidate_path,
  });
  if (!candidate) return;
  const manifestRelative = proposalManifestPath(record.candidate_path);
  const manifest = safePath(root, manifestRelative, findings, {
    artifact_id: record.artifact_id,
    issue: "proposal_manifest_invalid",
    side: "proposal",
    source_path: manifestRelative,
  });
  if (!manifest) return;
  if (!fs.existsSync(manifest.full)) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "proposal_manifest_missing",
      side: "proposal",
      source_path: manifestRelative,
    });
    return;
  }

  let parsed;
  try {
    parsed = proposal.parseProposalManifest(manifest.full, { root });
  } catch (error) {
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: proposalIssue(error.message),
      side: "proposal",
      source_path: manifestRelative,
      message: error.message,
    });
    return;
  }
  const value = parsed.manifest;
  const mismatches = [
    ["proposal_id", record.proposal_id, value.proposal_id],
    ["candidate_path", record.candidate_path, value.candidate_path],
    ["target_path", record.path, value.target_path],
    ["carrier_type", record.type, value.carrier_type],
    ["source_kn_ids", sortedValues(record.source_kn_ids), sortedValues(value.source_kn_ids)],
    ["source_refs", sortedValues(record.source_refs), sortedValues(value.source_refs)],
  ];
  for (const [field, actual, expected] of mismatches) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      addFinding(findings, {
        artifact_id: record.artifact_id,
        issue: field === "target_path" ? "proposal_target_drift" : "proposal_metadata_mismatch",
        side: "proposal",
        source_path: manifestRelative,
        expected,
        actual,
        message: `sidecar ${field} differs from the content-addressed proposal manifest`,
      });
    }
  }
  if (!fs.existsSync(candidate.full)) {
    // parseProposalManifest normally reports this, but keep the finding tied
    // to the candidate when a race removes it after manifest parsing.
    addFinding(findings, {
      artifact_id: record.artifact_id,
      issue: "proposal_candidate_missing",
      side: "proposal",
      source_path: record.candidate_path,
    });
  }
}

function scanArtifacts(root, findings) {
  const files = listFiles(root, "harness/artifacts", ".yaml", findings, "sidecar");
  const valid = [];
  for (const file of files) {
    const artifact = validateSidecar(file, root, findings);
    if (!artifact) continue;
    for (const sourceRef of artifact.record.source_refs) {
      scanSourceRef(root, sourceRef, artifact.record.artifact_id, findings, artifact.relative);
    }
    validateCarrierHashes(root, artifact, findings);
    validateProposal(root, artifact, findings);
    valid.push(artifact);
  }
  return { scanned: files.length, valid };
}

function scanKnowledge(root, findings) {
  const files = listFiles(root, "knowledge", ".md", findings, "knowledge");
  const valid = [];
  for (const file of files) {
    const entry = validateKnowledgeFile(file, root, findings);
    if (entry) valid.push(entry);
  }
  return valid;
}

function inverseSourcePath(finding, knowledgeById, carrierById) {
  if (finding.side === "knowledge" || finding.side === "both") {
    const pathValue = knowledgeById.get(finding.kn_id)?.relative;
    if (pathValue) return pathValue;
  }
  if (finding.artifact_id) return carrierById.get(finding.artifact_id)?.relative ?? null;
  return null;
}

function scanInverse(root, knowledgeEntries, carriers, findings) {
  const knowledgeById = new Map(knowledgeEntries.map((entry) => [entry.record.id, entry]));
  const carrierById = new Map(carriers.map((entry) => [entry.record.artifact_id, entry]));
  let result;
  try {
    result = inverseMap.validateInverseMap({
      knowledgeEntries: knowledgeEntries.map((entry) => entry.record),
      carriers: carriers.map((entry) => entry.record),
      root,
    });
  } catch (error) {
    addFinding(findings, {
      issue: "inverse_validator_failure",
      side: "both",
      message: error.message,
    });
    return;
  }
  for (const item of result.findings) {
    addFinding(findings, {
      artifact_id: item.artifact_id,
      issue: item.issue,
      severity: item.severity,
      side: item.side,
      kn_id: item.kn_id,
      carrier_ref: item.carrier_ref,
      source_path: inverseSourcePath(item, knowledgeById, carrierById),
      message: item.source_path && item.source_path !== inverseSourcePath(item, knowledgeById, carrierById)
        ? item.source_path
        : null,
    });
  }

  for (const carrier of carriers) {
    const status = carrier.record.status;
    for (const knId of carrier.record.source_kn_ids) {
      const knowledge = knowledgeById.get(knId)?.record;
      if (!knowledge) continue;
      if (status === "retired" && knowledge.lifecycle === "active") {
        addFinding(findings, {
          artifact_id: carrier.record.artifact_id,
          issue: "retired_carrier_linked_to_active_kn",
          side: "carrier",
          kn_id: knId,
          source_path: carrier.relative,
        });
      }
      if (knowledge.lifecycle === "candidate" && status !== "proposed") {
        addFinding(findings, {
          artifact_id: carrier.record.artifact_id,
          issue: "candidate_kn_requires_proposed_carrier",
          side: "carrier",
          kn_id: knId,
          source_path: carrier.relative,
        });
      }
    }
  }
}

function scanResidentSurface(root, findings) {
  const policy = protocol.loadScanPolicy();
  const configured = policy.resident_surface;
  const target = safePath(root, configured.path, findings, {
    issue: "resident_surface_path_invalid",
    side: "resident_surface",
    source_path: configured.path,
  });
  const surface = {
    path: configured.path,
    target_lines: configured.target_lines,
    present: false,
    line_count: null,
    within_target: null,
    knowledge_id: configured.knowledge_id,
  };
  if (!target || !fs.existsSync(target.full)) return surface;
  if (!fs.statSync(target.full).isFile()) {
    addFinding(findings, {
      issue: "resident_surface_not_file",
      side: "resident_surface",
      source_path: configured.path,
    });
    return surface;
  }
  const count = lineCount(fs.readFileSync(target.full));
  surface.present = true;
  surface.line_count = count;
  surface.within_target = count <= configured.target_lines;
  if (count > configured.target_lines) {
    addFinding(findings, {
      issue: configured.finding_issue,
      severity: "warning",
      side: "resident_surface",
      kn_id: configured.knowledge_id,
      source_path: configured.path,
      expected: configured.target_lines,
      actual: count,
      message: `${configured.knowledge_id}: ${configured.guidance}。`,
    });
  }
  return surface;
}

function findingSortKey(finding) {
  return JSON.stringify(FINDING_FIELDS.map((field) => finding[field]));
}

function canonicalReport(report) {
  const findings = [...report.findings].sort((left, right) => findingSortKey(left).localeCompare(findingSortKey(right)));
  const canonical = {
    kind: report.kind,
    version: report.version,
    scanned_at: report.scanned_at,
    artifacts_scanned: report.artifacts_scanned,
    findings: findings.map((finding) => {
      const out = {};
      for (const field of FINDING_FIELDS) out[field] = finding[field];
      return out;
    }),
    staleness_count: report.staleness_count,
    hard_error_count: report.hard_error_count,
    warning_count: report.warning_count,
    resident_surface: report.resident_surface,
    scan_limits: report.scan_limits,
  };
  if (JSON.stringify(Object.keys(canonical)) !== JSON.stringify(REPORT_FIELDS)) {
    throw new Error("internal scan report field order drifted");
  }
  return canonical;
}

export function buildScanReport(rootValue, nowValue) {
  const root = host.assertSafeHostRoot(rootValue);
  const now = nowValue ? new Date(nowValue) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now timestamp: ${nowValue}`);
  const findings = [];
  const artifacts = scanArtifacts(root, findings);
  const knowledge = scanKnowledge(root, findings);
  scanInverse(root, knowledge, artifacts.valid, findings);
  const residentSurface = scanResidentSurface(root, findings);
  const hardErrorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  return canonicalReport({
    kind: "kg.staleness_report",
    version: 2,
    scanned_at: now.toISOString(),
    artifacts_scanned: artifacts.scanned,
    findings,
    staleness_count: hardErrorCount,
    hard_error_count: hardErrorCount,
    warning_count: warningCount,
    resident_surface: residentSurface,
    scan_limits: {
      static_only: true,
      reads_kg: false,
      executes_host_code: false,
      follows_symlinks: false,
    },
  });
}

export { FINDING_FIELDS, REPORT_FIELDS };
