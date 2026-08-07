#!/usr/bin/env node

// Strict canonical writer for the isolated kg.scan_agent_report product.
// Confidence and agent severity remain human-readable metadata and never
// enter the deterministic builder or gate dependency graph.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { machineContract, protocol } from "./_lib.mjs";
import {
  AGENT_SCHEMA,
  normalizeAgentFindings,
  outputFile,
  readStrictJsonFile,
  validateAgentFindings,
  validateEvidencePacket,
} from "./agent-report-core.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(["--project-root", "--base-report", "--evidence-packet", "--input", "--output", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  for (const field of ["project_root", "base_report", "evidence_packet", "input", "output"]) {
    if (!out[field]) fail(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function canonicalReport({ raw, packet, packetState, now }) {
  machineContract.assertRawInput(raw, AGENT_SCHEMA, "scan agent report");
  validateAgentFindings(raw.findings, packetState);
  const normalizedRaw = { ...raw, findings: normalizeAgentFindings(raw.findings) };
  const reportSeed = machineContract.sha256CanonicalJson({
    base_report_sha256: packetState.base.sha256,
    evidence_packet_sha256: packetState.packetSha256,
    model: normalizedRaw.model,
    session_id: normalizedRaw.session_id,
    findings: normalizedRaw.findings,
  });
  const findings = normalizedRaw.findings.map((finding, index) => ({
    ...finding,
    finding_id: `SAF-${machineContract.sha256CanonicalJson({ report_seed: reportSeed, index, finding }).slice(-12).toUpperCase()}`,
    detection_mode: AGENT_SCHEMA.detection_mode_values[0],
  }));
  return machineContract.buildCanonicalRecord(
    normalizedRaw,
    {
      kind: AGENT_SCHEMA.product_kind,
      version: AGENT_SCHEMA.product_version,
      report_id: `SCAN-A-${reportSeed.slice(-12).toUpperCase()}`,
      generated_at: now.toISOString(),
      base_report_path: packetState.base.canonical,
      base_report_sha256: packetState.base.sha256,
      evidence_packet_path: packet.canonical,
      evidence_packet_sha256: packetState.packetSha256,
      detection_mode: AGENT_SCHEMA.detection_mode_values[0],
      findings,
    },
    AGENT_SCHEMA,
    "scan agent report",
  );
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const output = outputFile(args.output, "scan agent report", [".json", ".yaml"], args.project_root);
    const packet = readStrictJsonFile(args.evidence_packet, "evidence packet");
    const input = readStrictJsonFile(args.input, "scan agent input");
    const packetState = validateEvidencePacket({
      packet,
      projectRoot: args.project_root,
      baseReport: args.base_report,
    });
    const report = canonicalReport({ raw: input.record, packet, packetState, now: args.now });
    machineContract.writeCanonicalRecord(output, report, protocol.loadScanAgentReportSchema(), { label: "scan agent report" });
    console.log(`kg: wrote scan agent report ${report.report_id} with ${report.findings.length} finding(s)`);
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
