#!/usr/bin/env node

// Validate one agent-assisted ADR assessment and bind it to independently
// supplied evidence bytes plus a structured human approval event.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host, machineContract, protocol } from "./_lib.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(["--evidence-packet", "--transcript", "--input", "--output", "--now"]);
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
  for (const field of ["evidence_packet", "transcript", "input", "output"]) {
    if (!out[field]) fail(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function readJsonFile(value, label) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg")) throw new Error(`${label} must not enter .kg`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is not a file`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  try {
    return { file: host.canonicalPath(file), value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    throw new Error(`${label} must be strict JSON: ${error.message}`);
  }
}

function transcriptState(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("transcript must be an object");
  const allowed = new Set(["transcript", "approvals"]);
  const unknown = Object.keys(raw).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`transcript has unknown fields: ${unknown.join(", ")}`);
  if (!Array.isArray(raw.transcript) || !Array.isArray(raw.approvals)) {
    throw new Error("transcript must contain transcript and approvals lists");
  }
  for (const [index, message] of raw.transcript.entries()) {
    if (message === null || typeof message !== "object" || Array.isArray(message) ||
        !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error(`transcript[${index}] is invalid`);
    }
  }
  for (const [index, approval] of raw.approvals.entries()) {
    if (approval === null || typeof approval !== "object" || Array.isArray(approval) ||
        JSON.stringify(Object.keys(approval).sort()) !== JSON.stringify(["action", "message_index"]) ||
        typeof approval.action !== "string" || !Number.isInteger(approval.message_index) || approval.message_index < 0) {
      throw new Error(`approvals[${index}] is invalid`);
    }
    if (raw.transcript[approval.message_index]?.role !== "user") {
      throw new Error(`approvals[${index}] must point to a user message`);
    }
  }
  return raw;
}

function outputFile(value) {
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase())) throw new Error("output must use .json or .yaml");
  if (host.hasPathSegment(file, ".kg")) throw new Error("output must not enter .kg");
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite assessment: ${file}`);
  return file;
}

function canonicalAssessment({ raw, packet, packetFile, transcript, now }) {
  const schema = protocol.loadAdrAssessmentSchema();
  machineContract.assertRawInput(raw, schema, "ADR assessment");
  const packetErrors = protocol.validateRecord(packet, protocol.loadAdrEvidencePacketSchema());
  if (packetErrors.length > 0) throw new Error(`evidence packet is invalid: ${packetErrors.join("; ")}`);
  const candidate = packet.candidates.find((item) => item.candidate_ref === raw.candidate_ref);
  if (!candidate) throw new Error(`candidate_ref is absent from evidence packet: ${raw.candidate_ref}`);
  const expectedCriteria = Object.keys(schema.criteria);
  const actualCriteria = raw.criteria.map((item) => item.criterion_id);
  if (new Set(actualCriteria).size !== actualCriteria.length ||
      expectedCriteria.some((criterion) => !actualCriteria.includes(criterion)) || actualCriteria.length !== expectedCriteria.length) {
    throw new Error(`criteria must cover protocol IDs exactly: ${expectedCriteria.join(" | ")}`);
  }
  const allowedEvidence = new Set(candidate.evidence_refs);
  for (const criterion of raw.criteria) {
    for (const ref of criterion.evidence_refs) {
      if (!allowedEvidence.has(ref)) throw new Error(`${criterion.criterion_id} evidence is outside the candidate packet: ${ref}`);
    }
  }
  const message = transcript.transcript[raw.human_approval_message_index];
  if (!message || message.role !== "user") throw new Error("human_approval_message_index must point to a user message");
  const approvalAction = `${schema.approval_action_prefix}${raw.candidate_ref}`;
  const approved = transcript.approvals.some(
    (item) => item.message_index === raw.human_approval_message_index && item.action === approvalAction,
  );
  const eligible = raw.criteria.every((item) => item.conclusion === true) && approved;
  const packetSha256 = machineContract.sha256File(packetFile);
  const idSeed = machineContract.sha256CanonicalJson({ packet_sha256: packetSha256, candidate_ref: raw.candidate_ref });
  const criteria = expectedCriteria.map((criterionId) => raw.criteria.find((item) => item.criterion_id === criterionId));
  return machineContract.buildCanonicalRecord(
    { ...raw, criteria },
    {
      kind: schema.product_kind,
      version: schema.product_version,
      assessment_id: `ADR-ASSESS-${idSeed.slice(-12).toUpperCase()}`,
      assessed_at: now.toISOString(),
      detection_mode: schema.detection_mode_values[0],
      evidence_packet_sha256: packetSha256,
      human_approval_sha256: machineContract.sha256Bytes(message.content),
      eligible_for_draft: eligible,
    },
    schema,
    "ADR assessment",
  );
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const packet = readJsonFile(args.evidence_packet, "evidence packet");
    const transcript = transcriptState(readJsonFile(args.transcript, "transcript").value);
    const raw = readJsonFile(args.input, "input").value;
    const output = outputFile(args.output);
    const record = canonicalAssessment({
      raw,
      packet: packet.value,
      packetFile: packet.file,
      transcript,
      now: args.now,
    });
    machineContract.writeCanonicalRecord(output, record, protocol.loadAdrAssessmentSchema(), { label: "ADR assessment" });
    console.log(`kg: wrote ADR assessment ${record.assessment_id}; eligible_for_draft=${record.eligible_for_draft}`);
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
