// Independent checks for the R4.2 fresh-session evaluator.  This module
// intentionally recomputes byte hashes, proposal identities, and inverse
// pairs from host files instead of calling compile implementation helpers.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as kyaml from "./kyaml.mjs";

const MANAGED_SUFFIX = "managed";
const CO_MANAGED_SUFFIX = "co_managed_machine";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rawHash(value) {
  return `sha256:${sha256(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"))}`;
}

function normalizeManagedContent(content) {
  const normalized = String(content)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return normalized === "" ? "" : `${normalized}\n`;
}

function lineBounds(bytes, marker) {
  const needle = Buffer.from(marker, "utf8");
  const index = bytes.indexOf(needle);
  if (index < 0) throw new Error(`marker missing: ${marker}`);
  const lineStart = index === 0 ? 0 : bytes.lastIndexOf(0x0a, index - 1) + 1;
  if (lineStart !== index) throw new Error(`marker is not on its own line: ${marker}`);
  const after = index + needle.length;
  let lineEnd = after;
  if (bytes[after] === 0x0d && bytes[after + 1] === 0x0a) lineEnd += 2;
  else if (bytes[after] === 0x0a) lineEnd += 1;
  else if (after !== bytes.length) throw new Error(`marker is not on its own line: ${marker}`);
  return { index, lineStart, lineEnd };
}

function carrierHashes(bytes, record) {
  const id = record.artifact_id;
  const begin = lineBounds(bytes, `<!-- kg:managed ${id} begin -->`);
  const end = lineBounds(bytes, `<!-- kg:managed ${id} end -->`);
  if (record.ownership === "managed") {
    const prefix = bytes.subarray(0, begin.lineEnd);
    const machine = bytes.subarray(begin.lineEnd, end.index);
    const suffix = bytes.subarray(end.index);
    return {
      content_hash: rawHash(Buffer.from(normalizeManagedContent(machine.toString("utf8")), "utf8")),
      machine_segment_hash: rawHash(machine),
      human_segment_hash: null,
      outside_hash: rawHash(Buffer.concat([prefix, Buffer.from("\n<kg:managed-content>\n", "utf8"), suffix])),
    };
  }
  const humanBegin = lineBounds(bytes, `<!-- kg:co-managed ${id} human begin -->`);
  const humanEnd = lineBounds(bytes, `<!-- kg:co-managed ${id} human end -->`);
  const machineBegin = lineBounds(bytes, `<!-- kg:co-managed ${id} machine begin -->`);
  const machineEnd = lineBounds(bytes, `<!-- kg:co-managed ${id} machine end -->`);
  if (!(humanBegin.index < humanEnd.index && humanEnd.index <= machineBegin.index && machineBegin.index < machineEnd.index)) {
    throw new Error(`co-managed marker order is invalid: ${id}`);
  }
  const prefix = bytes.subarray(0, machineBegin.lineEnd);
  const human = bytes.subarray(humanBegin.lineEnd, humanEnd.index);
  const machine = bytes.subarray(machineBegin.lineEnd, machineEnd.index);
  const suffix = bytes.subarray(machineEnd.index);
  return {
    content_hash: rawHash(Buffer.from(normalizeManagedContent(machine.toString("utf8")), "utf8")),
    machine_segment_hash: rawHash(machine),
    human_segment_hash: rawHash(human),
    outside_hash: rawHash(Buffer.concat([prefix, Buffer.from("\n<kg:managed-content>\n", "utf8"), suffix])),
  };
}

function walkFiles(root, directory) {
  const out = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink in evaluator input: ${current}`);
    if (stat.isFile()) {
      out.push(current);
      return;
    }
    for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry));
  };
  visit(path.join(root, directory));
  return out;
}

function readFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`knowledge frontmatter missing: ${file}`);
  return kyaml.parse(match[1]);
}

function parseSidecars(root, context) {
  return context.artifacts.map((artifact) => {
    const file = path.join(root, artifact.sidecar_path);
    return { artifact, file, record: kyaml.parse(fs.readFileSync(file, "utf8")) };
  });
}

function expectedCarrierRef(record, routing) {
  const carrierPath = record.status === "proposed" || record.update_policy === "proposal_only" || record.ownership === "human" || record.type !== "markdown_document"
    ? record.candidate_path ?? record.path
    : record.path;
  if (record.type === "markdown_document" && record.ownership === "managed") {
    return `${record.artifact_id}@${carrierPath}#${routing.carrier_ref_suffixes[MANAGED_SUFFIX]}`;
  }
  if (record.type === "markdown_document" && record.ownership === "co_managed") {
    return `${record.artifact_id}@${carrierPath}#${routing.carrier_ref_suffixes[CO_MANAGED_SUFFIX]}`;
  }
  return `${record.artifact_id}@${carrierPath}#${routing.carrier_ref_suffixes.proposal}:${record.type}:${record.proposal_id}`;
}

function proposalDigest(manifest) {
  const payload = {
    carrier_type: manifest.carrier_type,
    target_path: manifest.target_path,
    target_sha256: manifest.target_sha256,
    candidate_path: manifest.candidate_path,
    candidate_sha256: manifest.candidate_sha256,
    source_kn_ids: [...manifest.source_kn_ids].sort(),
    source_refs: [...manifest.source_refs].sort(),
    generator_version: manifest.generator_version,
  };
  return sha256(Buffer.from(JSON.stringify(payload), "utf8"));
}

function auditProposals(root, sidecars) {
  const failures = [];
  const sensitiveTokens = [];
  const manifests = new Map();
  for (const file of walkFiles(root, "docs/proposals")) {
    if (path.basename(file) !== "manifest.json") continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      failures.push(`proposal manifest JSON invalid: ${file}: ${error.message}`);
      continue;
    }
    const digest = proposalDigest(manifest);
    const expectedId = `compile-${digest.slice(0, 16)}`;
    if (manifest.proposal_id !== expectedId) failures.push(`proposal identity mismatch: ${file}`);
    const candidateFile = path.join(root, manifest.candidate_path);
    if (!fs.existsSync(candidateFile)) failures.push(`proposal candidate missing: ${manifest.candidate_path}`);
    else if (rawHash(fs.readFileSync(candidateFile)) !== manifest.candidate_sha256) failures.push(`proposal candidate hash mismatch: ${manifest.candidate_path}`);
    if (manifest.target_path !== null) {
      const targetFile = path.join(root, manifest.target_path);
      if (!fs.existsSync(targetFile)) failures.push(`proposal target missing: ${manifest.target_path}`);
      else if (rawHash(fs.readFileSync(targetFile)) !== manifest.target_sha256) failures.push(`proposal target hash mismatch: ${manifest.target_path}`);
    }
    manifests.set(manifest.proposal_id, { manifest, file });
    sensitiveTokens.push(manifest.proposal_id, manifest.candidate_sha256, manifest.target_sha256);
  }
  const referenced = new Set();
  for (const { record } of sidecars) {
    if (record.status !== "proposed") continue;
    const bundle = manifests.get(record.proposal_id);
    if (!bundle) {
      failures.push(`proposed sidecar has no manifest: ${record.artifact_id}`);
      continue;
    }
    referenced.add(record.proposal_id);
    const { manifest } = bundle;
    if (manifest.target_path !== record.path || manifest.candidate_path !== record.candidate_path) failures.push(`proposal path mismatch: ${record.artifact_id}`);
    if (manifest.carrier_type !== record.type) failures.push(`proposal carrier type mismatch: ${record.artifact_id}`);
    if (JSON.stringify(manifest.source_kn_ids) !== JSON.stringify([...record.source_kn_ids].sort())) failures.push(`proposal source KN mismatch: ${record.artifact_id}`);
    if (JSON.stringify(manifest.source_refs) !== JSON.stringify([...record.source_refs].sort())) failures.push(`proposal source ref mismatch: ${record.artifact_id}`);
  }
  for (const [id, { manifest }] of manifests) {
    if (!referenced.has(id) && !String(manifest.target_path ?? "").startsWith("knowledge/")) {
      failures.push(`orphan proposal manifest: ${id}`);
    }
  }
  return { failures, sensitiveTokens };
}

function auditInverse(root, context, routing) {
  const failures = [];
  const sidecars = parseSidecars(root, context);
  const knowledgeFiles = walkFiles(root, "knowledge").filter((file) => file.endsWith(".md"));
  const knowledge = knowledgeFiles.map((file) => ({ file, record: readFrontmatter(file) }));
  const knownIds = new Set(knowledge.map(({ record }) => record.id));
  const carrierPairs = new Set();
  for (const { record } of sidecars) {
    if (!record.source_kn_ids?.length && record.ownership === "human" && record.proposal_id === null) continue;
    const ref = expectedCarrierRef(record, routing);
    for (const id of record.source_kn_ids ?? []) {
      if (!knownIds.has(id)) failures.push(`carrier points to unknown knowledge entry: ${record.artifact_id} -> ${id}`);
      carrierPairs.add(`${id}\u0000${ref}`);
    }
  }
  const knowledgePairs = new Set();
  for (const { record } of knowledge) {
    for (const ref of record.carrier_refs ?? []) knowledgePairs.add(`${record.id}\u0000${ref}`);
  }
  const onlyCarrier = [...carrierPairs].filter((pair) => !knowledgePairs.has(pair)).sort();
  const onlyKnowledge = [...knowledgePairs].filter((pair) => !carrierPairs.has(pair)).sort();
  for (const pair of onlyCarrier) failures.push(`inverse pair missing from knowledge: ${pair}`);
  for (const pair of onlyKnowledge) failures.push(`inverse pair missing from carrier: ${pair}`);
  return { failures, sidecars, knowledge };
}

export function auditR42({ root, context, report, plan, prompt, routingFile }) {
  const failures = [];
  const sensitiveTokens = [];
  if (report?.version !== 2) failures.push("R4.2 report version must be 2");
  if (!Array.isArray(report?.known_limitations) || report.known_limitations.length === 0) failures.push("R4.2 report known_limitations is missing");
  const dispositions = ["add", "update", "merge", "demote", "retire", "candidate", "no_change"];
  const actionByObservation = new Map();
  for (const action of report?.actions ?? []) {
    if (action.actor === "compile") {
      const prior = actionByObservation.get(action.observation_id);
      if (prior) failures.push(`multiple compile actions for observation: ${action.observation_id}`);
      actionByObservation.set(action.observation_id, action);
    }
  }
  for (const observation of context.observations) {
    if (!actionByObservation.has(observation.id)) failures.push(`observation has no compile action: ${observation.id}`);
  }
  for (const item of plan.items ?? []) if (!dispositions.includes(item.disposition)) failures.push(`invalid R4.2 disposition: ${item.disposition}`);
  const pending = walkFiles(root, ".kg/observations").filter((file) => file.endsWith(".yaml") && !file.includes(`${path.sep}processed${path.sep}`));
  if (pending.length) failures.push(`pending observations remain: ${pending.length}`);
  const processed = walkFiles(root, ".kg/observations/processed").filter((file) => file.endsWith(".yaml"));
  if (processed.length !== context.observations.length) failures.push(`processed observation count mismatch: ${processed.length}`);

  const routing = kyaml.parse(fs.readFileSync(routingFile, "utf8"));
  const inverse = auditInverse(root, context, routing);
  failures.push(...inverse.failures);
  const proposals = auditProposals(root, inverse.sidecars);
  failures.push(...proposals.failures);
  sensitiveTokens.push(...proposals.sensitiveTokens);

  for (const { record } of inverse.sidecars) {
    if (record.status === "proposed") continue;
    if (record.type !== "markdown_document" || record.ownership === "human") continue;
    try {
      const computed = carrierHashes(fs.readFileSync(path.join(root, record.path)), record);
      for (const field of ["content_hash", "machine_segment_hash", "human_segment_hash", "outside_hash"]) {
        if (computed[field] !== record[field]) failures.push(`target hash mismatch: ${record.artifact_id}/${field}`);
        if (computed[field]) sensitiveTokens.push(computed[field]);
      }
    } catch (error) {
      failures.push(`target hash audit failed for ${record.artifact_id}: ${error.message}`);
    }
  }

  const humanActions = (report.actions ?? []).filter((action) => action.actor === "human" && action.result_reason === "human_logged_update");
  for (const human of humanActions) {
    const compile = [...actionByObservation.values()].find((action) => action.target_kn_id === human.target_kn_id && action.disposition === "update");
    if (!compile || compile.update_scope !== "evidence_scope_refresh" || compile.body_action !== "preserved") {
      failures.push(`human-authored body was not preserved for ${human.target_kn_id}`);
    }
  }
  for (const token of sensitiveTokens.filter(Boolean)) if (prompt.includes(token)) failures.push(`oracle isolation failure: generated value leaked into prompt: ${token}`);
  return { failures, sensitiveTokens };
}
