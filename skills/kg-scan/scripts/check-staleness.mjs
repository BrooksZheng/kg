#!/usr/bin/env node

// Deterministic M2 staleness scan. It reads only harness sidecars and checks
// whether each source_refs path still exists. Line-range validation, hashes,
// reverse-link scans, and agent-assisted review belong to later milestones.
//
// D15 output schema:
// kind: kg.staleness_report
// version: 1
// scanned_at: <ISO timestamp>
// artifacts_scanned: <integer>
// findings[]:
//   detection_mode: deterministic
//   artifact_id: <HAR-id>
//   source_ref: <original path>
//   issue: missing_source
//   severity: high
// staleness_count: <integer>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harness, host } from "./_lib.mjs";

const REPORT_FIELDS = [
  "kind",
  "version",
  "scanned_at",
  "artifacts_scanned",
  "findings",
  "staleness_count",
];
const FINDING_FIELDS = [
  "detection_mode",
  "artifact_id",
  "source_ref",
  "issue",
  "severity",
];

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exitCode = 1;
}

function parseNonNegativeInteger(value, flag) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

function parseArgs(argv) {
  const out = { gates: false, max_staleness: 0 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--gates") {
      if (seen.has(flag)) throw new Error("--gates may be provided only once");
      seen.add(flag);
      out.gates = true;
      continue;
    }
    if (!["--root", "--output", "--now", "--max-staleness"].includes(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once`);
    seen.add(flag);
    out[key] = key === "max_staleness" ? parseNonNegativeInteger(value, flag) : value;
    index += 1;
  }
  if (!out.root) throw new Error("--root is required");
  return out;
}

function stripLineAnchor(sourceRef) {
  return String(sourceRef).replace(/#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/, "");
}

function artifactFiles(root) {
  const artifacts = host.resolveSafeRelative(root, "harness/artifacts", { mustExist: false });
  if (!fs.existsSync(artifacts.full)) return [];
  if (!fs.statSync(artifacts.full).isDirectory()) {
    throw new Error("harness/artifacts must be a directory");
  }
  const files = [];
  for (const entry of fs.readdirSync(artifacts.full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `harness/artifacts/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`harness artifact must not be a symbolic link: ${relative}`);
    if (entry.isDirectory()) throw new Error(`harness/artifacts must not contain directories: ${relative}`);
    if (entry.isFile() && entry.name.endsWith(".yaml")) {
      files.push(host.resolveSafeRelative(root, relative).full);
    }
  }
  return files;
}

function canonicalReport(report) {
  const canonical = {
    kind: report.kind,
    version: report.version,
    scanned_at: report.scanned_at,
    artifacts_scanned: report.artifacts_scanned,
    findings: report.findings.map((finding) => ({
      detection_mode: finding.detection_mode,
      artifact_id: finding.artifact_id,
      source_ref: finding.source_ref,
      issue: finding.issue,
      severity: finding.severity,
    })),
    staleness_count: report.staleness_count,
  };
  if (JSON.stringify(Object.keys(canonical)) !== JSON.stringify(REPORT_FIELDS)) {
    throw new Error("internal staleness report field order drifted");
  }
  for (const finding of canonical.findings) {
    if (JSON.stringify(Object.keys(finding)) !== JSON.stringify(FINDING_FIELDS)) {
      throw new Error("internal staleness finding field order drifted");
    }
  }
  return canonical;
}

export function scanStaleness(rootValue, nowValue) {
  const root = host.assertSafeHostRoot(rootValue);
  const now = nowValue ? new Date(nowValue) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now timestamp: ${nowValue}`);
  const findings = [];
  const files = artifactFiles(root);
  for (const file of files) {
    const sidecar = harness.readHarnessSidecar(root, file);
    for (const sourceRef of sidecar.source_refs) {
      const relative = stripLineAnchor(sourceRef);
      let source;
      try {
        source = host.resolveSafeRelative(root, relative, { mustExist: false });
      } catch (error) {
        throw new Error(`harness source_ref ${sourceRef} is invalid: ${error.message}`);
      }
      if (!fs.existsSync(source.full)) {
        findings.push({
          detection_mode: "deterministic",
          artifact_id: sidecar.artifact_id,
          source_ref: sourceRef,
          issue: "missing_source",
          severity: "high",
        });
      } else if (!fs.statSync(source.full).isFile()) {
        throw new Error(`harness source_ref ${sourceRef} must resolve to a file`);
      }
    }
  }
  findings.sort((left, right) =>
    `${left.artifact_id}\0${left.source_ref}`.localeCompare(`${right.artifact_id}\0${right.source_ref}`),
  );
  return canonicalReport({
    kind: "kg.staleness_report",
    version: 1,
    scanned_at: now.toISOString(),
    artifacts_scanned: files.length,
    findings,
    staleness_count: findings.length,
  });
}

function writeReport(report, outputValue) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (!outputValue) {
    process.stdout.write(text);
    return;
  }
  const output = path.resolve(outputValue);
  if (
    host.hasPathSegment(output, ".kg") ||
    host.hasPathSegment(host.canonicalPath(output), ".kg")
  ) {
    throw new Error(`report output must not be inside .kg: ${output}`);
  }
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite report: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text, { flag: "wx" });
  process.stdout.write(text);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    const report = scanStaleness(args.root, args.now);
    writeReport(report, args.output);
    if (args.gates && report.staleness_count > args.max_staleness) {
      console.error(
        `kg: staleness gate failed: ${report.staleness_count} exceeds ${args.max_staleness}`,
      );
      process.exitCode = 2;
    }
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
