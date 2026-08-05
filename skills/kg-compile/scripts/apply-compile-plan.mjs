// The only M2 compile mutation entry. It consumes an agent-authored JSON plan,
// performs complete preflight, then applies every result through the existing
// record writers and archive entrypoint.
//
// Usage:
//   node apply-compile-plan.mjs --root <host> --context <context.json>
//     --plan <plan.json> [--now <ISO>] [--check]

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kyaml, protocol, host, harness, compilePlan, inverseMap, proposal } from "./_lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADD_ENTRY = path.join(SCRIPT_DIR, "add-entry.mjs");
const ADD_QUEUE_ITEM = path.join(SCRIPT_DIR, "add-queue-item.mjs");
const ARCHIVE_OBSERVATION = path.join(SCRIPT_DIR, "archive-observations.mjs");
const PLAN_FIELDS = ["kind", "version", "items"];
const ITEM_FIELDS = {
  publish_kn_and_carrier: ["observation_id", "result_type", "knowledge", "carrier"],
  queue_only: ["observation_id", "result_type", "queue"],
  no_change: ["observation_id", "result_type", "reason"],
};
const KNOWLEDGE_FIELDS = ["claim", "category", "scope", "authority", "confidence", "body"];
const CARRIER_FIELDS = ["artifact_id", "content"];
const QUEUE_FIELDS = ["claim", "evidence", "options", "recommendation"];
const EVIDENCE_FIELDS = ["type", "ref"];
const KNOWN_LIMITATIONS = [
  "M2 deterministic validation proves bidirectional reference existence and managed-block hash consistency. It does not prove that rendered prose is semantically equivalent to sidecar source_kn_ids; M5 agent-assisted scan owns that check.",
];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const out = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      if (out.check) fail("--check may be supplied only once");
      out.check = true;
      continue;
    }
    if (!["--root", "--context", "--plan", "--now"].includes(arg)) fail(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
    const key = arg.slice(2);
    if (out[key]) fail(`${arg} may be supplied only once`);
    out[key] = value;
    index += 1;
  }
  if (!out.root) out.root = host.findHostRoot();
  if (!out.context || !out.plan) {
    fail("usage: apply-compile-plan.mjs --root <host> --context <context.json> --plan <plan.json> [--now <ISO>] [--check]");
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now timestamp: ${out.now}`);
  return { ...out, now };
}

function assertExternalJson(fileValue, label) {
  const file = path.resolve(fileValue);
  if (host.hasPathSegment(file, ".kg")) fail(`${label} must not be inside .kg`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${label} does not exist: ${file}`);
  if (fs.lstatSync(file).isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  host.canonicalPath(file);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return { file, value };
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactFields(value, fields, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function validateScope(scope, label) {
  assertPlainObject(scope, label);
  const unknown = Object.keys(scope).filter((field) => !["paths", "domains"].includes(field));
  if (unknown.length) fail(`${label} has unknown field(s): ${unknown.join(", ")}`);
  for (const field of Object.keys(scope)) {
    if (!Array.isArray(scope[field]) || !scope[field].every((value) => typeof value === "string" && value.trim() !== "")) {
      fail(`${label}.${field} must be a list of non-empty strings`);
    }
  }
}

function validateEvidence(evidence, label) {
  if (!Array.isArray(evidence) || evidence.length === 0) fail(`${label} must contain at least one evidence item`);
  for (const [index, item] of evidence.entries()) {
    assertExactFields(item, EVIDENCE_FIELDS, `${label}[${index}]`);
    if (!["diff", "test", "log", "quote"].includes(item.type)) fail(`${label}[${index}].type is invalid`);
    if (typeof item.ref !== "string" || item.ref.trim() === "") fail(`${label}[${index}].ref is required`);
  }
}

function validatePlan(plan) {
  return compilePlan.validateCompilePlan(plan);
}

function portableRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function readObservation(root, input) {
  const pending = harness.resolveCompileInput(root, input.path).full;
  const processed = path.join(root, ".kg", "observations", "processed", `${input.id}.yaml`);
  const file = fs.existsSync(pending) ? pending : processed;
  if (!fs.existsSync(file)) fail(`observation state is missing for ${input.id}`);
  const record = kyaml.parse(fs.readFileSync(file, "utf8"));
  const errors = protocol.validateRecord(record, protocol.loadObservationSchema());
  if (record.id !== input.id) errors.push(`observation id must equal ${input.id}`);
  if (errors.length) fail(`observation ${input.id} is invalid: ${errors.join("; ")}`);
  return { record, pending, processed };
}

function incrementKnId(first, offset) {
  return `KN-${String(Number.parseInt(first.slice(3), 10) + offset).padStart(4, "0")}`;
}

function nextQueueIds(paths, count, now) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  let max = 0;
  for (const file of host.listFiles(paths.queue, ".yaml")) {
    const match = new RegExp(`^Q-${day}-(\\d{3})\\.yaml$`).exec(path.basename(file));
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return Array.from({ length: count }, (_, index) => `Q-${day}-${String(max + index + 1).padStart(3, "0")}`);
}

function reservationDirectory(paths) {
  return path.join(paths.kg, "ids", "reservations");
}

function readDurableReservations(paths) {
  const directory = reservationDirectory(paths);
  if (!fs.existsSync(directory)) return [];
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  return files.map((file) => {
    let reservation;
    try {
      reservation = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      fail(`durable ID reservation is invalid: ${file}: ${error.message}`);
    }
    if (reservation?.kind !== "kg.compile_id_reservation" || !reservation.plan_digest) {
      fail(`durable ID reservation shape is invalid: ${file}`);
    }
    return reservation;
  });
}

function numericPart(value, prefix) {
  const match = new RegExp(`^${prefix}([0-9]+)$`).exec(value ?? "");
  return match ? Number.parseInt(match[1], 10) : null;
}

function rangesOverlap(start, end, ranges) {
  return ranges.some((range) => start <= range.end && end >= range.start);
}

function reservedKnowledgeRanges(paths) {
  return readDurableReservations(paths)
    .map((reservation) => reservation.allocation?.knowledge)
    .filter((range) => range?.start && range?.end)
    .map((range) => ({ start: numericPart(range.start, "KN-"), end: numericPart(range.end, "KN-") }))
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end));
}

function reservedQueueRanges(paths, day) {
  return readDurableReservations(paths)
    .map((reservation) => reservation.allocation?.queue)
    .filter((range) => range?.day === day && range.start && range.end)
    .map((range) => ({ start: numericPart(range.start, `Q-${day}-`), end: numericPart(range.end, `Q-${day}-`) }))
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end));
}

function nextKnowledgeIds(paths, count) {
  if (count === 0) return [];
  let start = Number.parseInt(host.nextKnowledgeId(paths).slice(3), 10);
  const ranges = reservedKnowledgeRanges(paths);
  while (rangesOverlap(start, start + count - 1, ranges)) {
    start = Math.max(...ranges.filter((range) => start <= range.end && start + count - 1 >= range.start).map((range) => range.end + 1));
  }
  if (start + count - 1 > 9999) fail("knowledge id space exhausted by the durable reservation");
  return Array.from({ length: count }, (_, index) => `KN-${String(start + index).padStart(4, "0")}`);
}

function nextQueueIdsWithReservations(paths, count, now) {
  if (count === 0) return [];
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  let start = 1;
  for (const file of host.listFiles(paths.queue, ".yaml")) {
    const value = numericPart(path.basename(file, ".yaml"), `Q-${day}-`);
    if (value !== null) start = Math.max(start, value + 1);
  }
  const ranges = reservedQueueRanges(paths, day);
  while (rangesOverlap(start, start + count - 1, ranges)) {
    start = Math.max(...ranges.filter((range) => start <= range.end && start + count - 1 >= range.start).map((range) => range.end + 1));
  }
  if (start + count - 1 > 999) fail(`queue id space exhausted for ${day}`);
  return Array.from({ length: count }, (_, index) => `Q-${day}-${String(start + index).padStart(3, "0")}`);
}

function renderKnowledge(record, body) {
  const errors = protocol.validateRecord(record, protocol.loadKnowledgeSchema());
  if (errors.length) fail(`prepared knowledge entry is invalid: ${errors.join("; ")}`);
  return `---\n${kyaml.stringify(record)}---\n\n${body.trim()}\n`;
}

function renderQueueRecord(id, now, queue, observationId) {
  return kyaml.stringify({
    id,
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    kind: "conflict",
    category: "needs_human_decision",
    claim: queue.claim,
    evidence: queue.evidence,
    options: queue.options,
    recommendation: queue.recommendation,
    entry: null,
    source_observations: [observationId],
    resolution: "pending",
    resolution_note: null,
  });
}

function canonicalList(values) {
  return [...new Set((values ?? []).filter((value) => value !== null && value !== undefined).map(String))].sort((a, b) => a.localeCompare(b));
}

function canonicalEvidence(values) {
  const seen = new Set();
  return [...(values ?? [])]
    .filter((value) => value && typeof value.type === "string" && typeof value.ref === "string")
    .map((value) => ({ type: value.type, ref: value.ref }))
    .filter((value) => {
      const key = `${value.type}\u0000${value.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.type}\u0000${a.ref}`.localeCompare(`${b.type}\u0000${b.ref}`));
}

function canonicalScope(left, right) {
  return {
    paths: canonicalList([...(left?.paths ?? []), ...(right?.paths ?? [])]),
    domains: canonicalList([...(left?.domains ?? []), ...(right?.domains ?? [])]),
  };
}

function knowledgeFile(root, id) {
  const files = host.listFiles(host.kgPaths(root).knowledge, ".md").filter((file) => {
    const name = path.basename(file);
    return name === `${id}.md` || name.startsWith(`${id}-`);
  });
  if (files.length !== 1) fail(`knowledge id ${id} must resolve to exactly one file`);
  const file = files[0];
  const parsed = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
  if (parsed.frontmatter.id !== id) fail(`knowledge frontmatter id does not match ${id}`);
  const errors = protocol.validateRecord(parsed.frontmatter, protocol.loadKnowledgeSchema());
  if (errors.length || parsed.body.trim() === "") fail(`knowledge ${id} is invalid: ${errors.join("; ") || "body is empty"}`);
  return {
    id,
    file,
    path: portableRelative(root, file),
    text: fs.readFileSync(file, "utf8"),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
}

function canonicalKnowledge(record) {
  const out = {};
  for (const field of protocol.loadKnowledgeSchema().field_order) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

function renderKnowledgeCanonical(record, body, preserveBytes = false) {
  const canonical = canonicalKnowledge(record);
  const errors = protocol.validateRecord(canonical, protocol.loadKnowledgeSchema());
  if (errors.length) fail(`prepared knowledge entry is invalid: ${errors.join("; ")}`);
  const renderedBody = preserveBytes ? body : `${body.trim()}\n`;
  return `---\n${kyaml.stringify(canonical)}---\n${renderedBody.startsWith("\n") ? renderedBody : `\n${renderedBody}`}`;
}

function operationWrite(root, relative, expectedText, beforeSha256 = null) {
  const file = path.resolve(root, ...String(relative).split("/"));
  if (host.isOutside(root, file)) fail(`compile transaction write escapes host root: ${relative}`);
  return {
    path: String(relative).split(path.sep).join("/"),
    before_sha256: beforeSha256,
    expected_text: expectedText,
  };
}

function currentHumanLoggedUpdate(root, id) {
  const paths = host.kgPaths(root);
  const actions = [];
  for (const action of host.readRoundActions(paths)) {
    if (action.actor === "human" && action.action === "update" && action.entry === id) actions.push(action);
  }
  for (const file of host.listFiles(paths.reports, ".json")) {
    if (!path.basename(file).startsWith("COMPILE-")) continue;
    try {
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const action of report.actions ?? []) {
        if (action.actor === "human" && action.target_kn_id === id && action.result_reason === "human_logged_update") {
          actions.push({ ...action, at: action.action_at ?? report.generated_at });
        }
      }
    } catch {
      // An unrelated malformed historical report is handled by report validation.
    }
  }
  const compileTimes = [];
  for (const file of host.listFiles(paths.reports, ".json")) {
    if (!path.basename(file).startsWith("COMPILE-")) continue;
    try {
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      if ((report.actions ?? []).some((action) => action.actor === "compile" && action.target_kn_id === id && action.disposition === "update")) {
        compileTimes.push(new Date(report.generated_at).getTime());
      }
    } catch {
      // Ignore unrelated reports here; the active compile still validates its inputs.
    }
  }
  const lastCompile = compileTimes.length ? Math.max(...compileTimes) : -Infinity;
  return actions
    .filter((action) => Number.isFinite(new Date(action.at).getTime()) && new Date(action.at).getTime() > lastCompile)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function proposalBundle(root, { carrierType, targetPath, targetBytes, candidateBytes, sourceKnIds, sourceRefs, extension }) {
  const targetSha = targetBytes === null ? null : `sha256:${sha256(targetBytes)}`;
  const candidateSha = `sha256:${sha256(candidateBytes)}`;
  const base = sha256(Buffer.from(JSON.stringify({
    carrier_type: carrierType,
    target_path: targetPath,
    target_sha256: targetSha,
    candidate_sha256: candidateSha,
    source_kn_ids: canonicalList(sourceKnIds),
    source_refs: canonicalList(sourceRefs),
  }), "utf8")).slice(0, 16);
  const bundle = `docs/proposals/compile-${base}`;
  const candidatePath = `${bundle}/candidate.${extension}`;
  const manifestPath = `${bundle}/manifest.json`;
  const manifest = {
    kind: "kg.carrier_proposal",
    version: 1,
    proposal_id: "compile-pending",
    carrier_type: carrierType,
    target_path: targetPath,
    target_sha256: targetSha,
    candidate_path: candidatePath,
    candidate_sha256: candidateSha,
    source_kn_ids: canonicalList(sourceKnIds),
    source_refs: canonicalList(sourceRefs),
    generator_version: "kg-compile/4.2.0",
    status: "proposed",
  };
  manifest.proposal_id = `compile-${proposal.proposalManifestDigest(manifest).slice(0, 16)}`;
  const manifestText = proposal.renderProposalManifest(manifest);
  return {
    manifest,
    proposalId: manifest.proposal_id,
    candidatePath,
    writes: [
      operationWrite(root, candidatePath, candidateBytes.toString("utf8")),
      operationWrite(root, manifestPath, manifestText),
    ],
  };
}

function renderedMachineContent(sourceIds, content) {
  const text = String(content);
  const markers = canonicalList(sourceIds).filter((id) => !text.includes(`<!-- kg:source ${id} -->`));
  return `${markers.map((id) => `<!-- kg:source ${id} -->`).join("\n")}${markers.length ? "\n" : ""}${text.trim()}`;
}

function canonicalAggregatedContent(items) {
  return items
    .slice()
    .sort((left, right) => {
      const a = left.item;
      const b = right.item;
      return (
        compilePlan.dispositionRank(a.disposition) - compilePlan.dispositionRank(b.disposition) ||
        a.observation_id.localeCompare(b.observation_id) ||
        String(a.target_kn_id ?? "").localeCompare(String(b.target_kn_id ?? "")) ||
        String(a.carrier?.artifact_id ?? "").localeCompare(String(b.carrier?.artifact_id ?? ""))
      );
    })
    .map(({ item, knId }) => `<!-- kg:source ${knId} -->\n${String(item.carrier.content).trim()}`)
    .join("\n");
}

function validateMatrixRegion(artifact) {
  const region = protocol.loadRouting().ownership_update_matrix?.[artifact.ownership]?.[artifact.update_policy];
  if (region === "none") fail(`compile carrier has no compile-owned region: ${artifact.artifact_id}`);
  if (region === "reject" || region === undefined) {
    fail(`compile carrier ownership/update_policy is rejected: ${artifact.artifact_id}`);
  }
  return region;
}

function prepareCarrierMutation(root, request, now) {
  const artifact = request.artifact;
  const region = validateMatrixRegion(artifact);
  const sidecarFile = harness.resolveCompileInput(root, artifact.sidecar_path).full;
  const targetFile = harness.resolveCompileInput(root, artifact.target_path).full;
  const sidecar = harness.readHarnessSidecar(root, sidecarFile);
  harness.validateHarnessReferences(root, sidecar);
  const targetBytes = fs.readFileSync(targetFile);
  const sourceIds = canonicalList([...(sidecar.source_kn_ids ?? []), ...request.sourceIds]);
  const writes = [];
  let updatedSidecar = { ...sidecar, source_kn_ids: sourceIds };
  let carrierRef;

  const effectivePolicy = request.forceProposal ? "proposal_only" : artifact.update_policy;
  if (effectivePolicy === "automatic") {
    if (artifact.type !== "markdown_document") fail(`automatic carrier updates require Markdown markers: ${artifact.artifact_id}`);
    const beforeBlock = harness.inspectCarrier(targetBytes, artifact.artifact_id, artifact.ownership);
    const machineContent = renderedMachineContent(sourceIds, request.content);
    const afterText = artifact.ownership === "managed"
      ? harness.replaceManagedBlock(targetBytes, artifact.artifact_id, machineContent)
      : harness.replaceCoManagedMachineSegment(targetBytes, artifact.artifact_id, machineContent);
    const afterBlock = harness.inspectCarrier(Buffer.from(afterText, "utf8"), artifact.artifact_id, artifact.ownership);
    harness.assertTransactionByteFence(beforeBlock, afterBlock);
    updatedSidecar = {
      ...updatedSidecar,
      content_hash: afterBlock.contentHash,
      machine_segment_hash: afterBlock.machine_segment_hash,
      human_segment_hash: afterBlock.human_segment_hash,
      outside_hash: afterBlock.outside_hash,
      generator_version: "kg-compile/4.2.0",
      last_verified: now.toISOString().slice(0, 10),
    };
    writes.push(operationWrite(root, artifact.target_path, afterText, artifact.target_sha256));
    carrierRef = inverseMap.carrierRefForSidecar(updatedSidecar, { root });
  } else {
    let candidateBytes;
    if (artifact.type === "markdown_document" && artifact.ownership !== "human" && region !== "whole_target") {
      const machineContent = renderedMachineContent(sourceIds, request.content);
      const candidateText = artifact.ownership === "managed"
        ? harness.replaceManagedBlock(targetBytes, artifact.artifact_id, machineContent)
        : harness.replaceCoManagedMachineSegment(targetBytes, artifact.artifact_id, machineContent);
      candidateBytes = Buffer.from(candidateText, "utf8");
    } else {
      candidateBytes = Buffer.from(String(request.content), "utf8");
    }
    const bundle = proposalBundle(root, {
      carrierType: artifact.type,
      targetPath: artifact.target_path,
      targetBytes,
      candidateBytes,
      sourceKnIds: sourceIds,
      sourceRefs: artifact.source_refs,
      extension: artifact.type === "markdown_document" ? "md" : "mjs",
    });
    updatedSidecar = {
      ...updatedSidecar,
      status: "proposed",
      proposal_id: bundle.proposalId,
      candidate_path: bundle.candidatePath,
      generator_version: "kg-compile/4.2.0",
      last_verified: now.toISOString().slice(0, 10),
      update_policy: "proposal_only",
    };
    writes.push(...bundle.writes);
    carrierRef = inverseMap.carrierRefForSidecar(updatedSidecar, { root });
  }
  writes.push(operationWrite(root, artifact.sidecar_path, harness.renderHarnessSidecar(updatedSidecar), artifact.sha256));
  return { writes, sourceIds, carrierRef, updatedSidecar };
}

function transitionRecord(record, toState, { regret = null, supersededBy = null } = {}) {
  const lifecycle = protocol.loadLifecycle();
  const from = record.lifecycle;
  if (!lifecycle.states.includes(toState)) fail(`unknown lifecycle state: ${toState}`);
  const allowed = (lifecycle.transitions[from] ?? "").split("|").filter(Boolean);
  if (!allowed.includes(toState)) fail(`illegal transition ${from} -> ${toState} for ${record.id}`);
  if (lifecycle.regret_required_on_enter.includes(toState) && !(regret && regret.trim())) {
    fail(`transition to ${toState} requires a regret: ${record.id}`);
  }
  if (toState === "archived" && lifecycle.archive_from_live_requires_reason.includes(from) && !supersededBy && !(regret && regret.trim())) {
    fail(`archiving ${record.id} requires a regret or survivor`);
  }
  return {
    ...record,
    lifecycle: toState,
    ...(regret ? { regret: regret.trim() } : {}),
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  };
}

function renderPromotionQueue(id, now, item, entryId) {
  return kyaml.stringify({
    id,
    at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    kind: "promotion",
    category: item.knowledge.category,
    claim: item.knowledge.claim,
    evidence: item.knowledge.body ? [{ type: "quote", ref: `candidate ${entryId}` }] : [{ type: "quote", ref: item.observation_id }],
    options: ["accept candidate", "reject candidate"],
    recommendation: "Keep the candidate inactive until a human ruling is recorded.",
    entry: entryId,
    source_observations: [item.observation_id],
    resolution: "pending",
    resolution_note: null,
  });
}

function buildV2Report(planDigest, contextDigest, now, operations, humanActions) {
  const results = { add: [], update: [], merge: [], demote: [], retire: [], candidate: [], no_change: [] };
  const actions = [];
  for (const operation of operations) {
    const actionId = `ACT-${sha256(Buffer.from(`${operation.observation_id}:${operation.disposition}:${operation.observation_sha256}`, "utf8")).slice(0, 16)}`;
    const action = {
      action_id: actionId,
      observation_id: operation.observation_id,
      disposition: operation.disposition,
      actor: "compile",
      update_scope: operation.update_scope,
      body_action: operation.body_action ?? "preserved",
      source_observation_sha256: operation.observation_sha256,
      target_kn_id: operation.target_kn_id ?? operation.kn_id ?? null,
      artifact_id: operation.artifact_id ?? null,
      result_reason: operation.result_reason,
      actions: operation.action_names,
      action_at: now.toISOString(),
    };
    results[operation.disposition].push(action);
    actions.push(action);
  }
  for (const human of humanActions) {
    const target = knowledgeFile(planDigest.root, human.entry);
    const action = {
      action_id: `ACT-${sha256(Buffer.from(`human:${human.entry}:${human.at}`, "utf8")).slice(0, 16)}`,
      observation_id: `human:${human.entry}`,
      disposition: "update",
      actor: "human",
      update_scope: "full",
      body_action: "updated",
      source_observation_sha256: sha256(Buffer.from(target.text, "utf8")),
      target_kn_id: human.entry,
      artifact_id: null,
      result_reason: "human_logged_update",
      actions: ["human_logged_update"],
      action_at: human.at,
    };
    actions.push(action);
  }
  return {
    kind: "kg.compile_report",
    version: 2,
    plan_digest: planDigest.value,
    context_digest: contextDigest,
    generated_at: now.toISOString(),
    known_limitations: KNOWN_LIMITATIONS,
    results,
    actions,
    archives: operations.map((operation) => ({ observation_id: operation.observation_id, arguments: operation.archive_args })),
  };
}

function buildFreshJournalV2(root, context, plan, planDigest, now) {
  const paths = host.kgPaths(root);
  validateCurrentInverseMap(root);
  const observationInputs = new Map(context.observations.map((input) => [input.id, input]));
  const artifactInputs = new Map(context.artifacts.map((input) => [input.artifact_id, input]));
  const sortedItems = compilePlan.sortPlanItems(plan.items);
  const allocatedKnowledgeIds = nextKnowledgeIds(
    paths,
    sortedItems.filter((item) => ["add", "candidate"].includes(item.disposition)).length,
  );
  const queueIds = nextQueueIdsWithReservations(
    paths,
    sortedItems.filter((item) => item.disposition === "candidate").length,
    now,
  );
  let knOffset = 0;
  let queueOffset = 0;
  const observations = new Map();
  for (const item of sortedItems) {
    const input = observationInputs.get(item.observation_id);
    if (!input) fail(`plan observation was not present in compile context: ${item.observation_id}`);
    const observation = readObservation(root, input);
    if (!fs.existsSync(observation.pending)) fail(`fresh compile preflight requires a pending observation: ${item.observation_id}`);
    if (fs.existsSync(observation.processed)) fail(`processed observation target already exists: ${item.observation_id}`);
    observations.set(item.observation_id, { input, record: observation.record });
  }

  const itemPlans = sortedItems.map((item) => {
    const targetId = item.target_kn_id ?? null;
    const knId = ["add", "candidate"].includes(item.disposition)
      ? allocatedKnowledgeIds[knOffset++]
      : targetId;
    if (["update", "merge", "demote", "retire"].includes(item.disposition)) knowledgeFile(root, targetId);
    const op = {
      protocol_version: 2,
      observation_id: item.observation_id,
      observation_path: observations.get(item.observation_id).input.path,
      observation_sha256: observations.get(item.observation_id).input.sha256,
      disposition: item.disposition,
      update_scope: item.update_scope,
      body_action: item.body_action ?? "preserved",
      target_kn_id: targetId,
      kn_id: ["add", "update", "candidate"].includes(item.disposition) ? knId : null,
      artifact_id: item.carrier?.artifact_id ?? null,
      result_reason: item.reason ?? `${item.disposition} applied by protocol-driven compile transaction`,
      action_names: [],
      writes: [],
      archive_args: [],
    };
    return { item, observation: observations.get(item.observation_id).record, knId, op };
  });

  const carrierRequests = new Map();
  for (const planItem of itemPlans) {
    if (!["add", "update", "candidate"].includes(planItem.item.disposition)) continue;
    const artifact = artifactInputs.get(planItem.item.carrier.artifact_id);
    if (!artifact) fail(`carrier artifact was not present in compile context: ${planItem.item.carrier.artifact_id}`);
    const request = carrierRequests.get(artifact.artifact_id) ?? {
      artifact,
      sourceIds: new Set(),
      content: planItem.item.carrier.content,
      items: [],
      forceProposal: false,
    };
    request.sourceIds.add(planItem.knId);
    request.forceProposal ||= planItem.item.disposition === "candidate";
    request.items.push(planItem);
    request.content = canonicalAggregatedContent(request.items);
    carrierRequests.set(artifact.artifact_id, request);
  }
  const carrierPlans = new Map();
  for (const [artifactId, request] of carrierRequests) {
    const prepared = prepareCarrierMutation(root, { ...request, sourceIds: [...request.sourceIds] }, now);
    carrierPlans.set(artifactId, { ...prepared, request });
  }

  const desired = new Map();
  const ownerByKn = new Map();
  const proposalWritesByOp = new Map();
  for (const planItem of itemPlans) {
    const { item, observation, knId, op } = planItem;
    const artifactPlan = item.carrier ? carrierPlans.get(item.carrier.artifact_id) : null;
    const carrierRef = artifactPlan?.carrierRef ?? null;
    if (item.disposition === "add" || item.disposition === "candidate") {
      const route = protocol.loadRouting().categories[item.knowledge.category];
      if (!route) fail(`knowledge category is not routed: ${item.knowledge.category}`);
      const record = {
        id: knId,
        claim: item.knowledge.claim,
        category: item.knowledge.category,
        scope: item.knowledge.scope,
        evidence: canonicalEvidence([{ type: "observation", ref: item.observation_id }]),
        authority: item.knowledge.authority,
        confidence: item.knowledge.confidence,
        lifecycle: item.disposition === "candidate" || route.autonomy === "human_review" ? "candidate" : "active",
        supersedes: null,
        last_verified: now.toISOString().slice(0, 10),
        regret: null,
        source_obs_ids: [item.observation_id],
        carrier_refs: carrierRef ? [carrierRef] : [],
      };
      desired.set(knId, { record, body: item.knowledge.body, preserve: false, owner: op });
      ownerByKn.set(knId, op);
      op.action_names.push(item.disposition === "candidate" ? "create_candidate" : "create_kn");
      if (item.disposition === "candidate") {
        const queueId = queueIds[queueOffset++];
        op.queue = { id: queueId, path: `.kg/queue/${queueId}.yaml`, expected_text: renderPromotionQueue(queueId, now, item, knId) };
        op.action_names.push("create_promotion_queue");
        op.archive_args = ["--observation", item.observation_id, "--compiled-to-kn", knId];
      } else {
        op.archive_args = ["--observation", item.observation_id, "--compiled-to-kn", knId];
      }
    } else if (item.disposition === "update") {
      const existing = knowledgeFile(root, knId);
      if (existing.frontmatter.claim !== item.knowledge.claim) fail(`update target claim does not match ${knId}; use add or merge for a new claim`);
      const humanActions = currentHumanLoggedUpdate(root, knId);
      const preserveBody = humanActions.length > 0;
      const nextRecord = {
        ...existing.frontmatter,
        scope: canonicalScope(existing.frontmatter.scope, item.knowledge.scope),
        evidence: canonicalEvidence([...(existing.frontmatter.evidence ?? []), ...(observation.evidence ?? [])]),
        last_verified: now.toISOString().slice(0, 10),
        source_obs_ids: canonicalList([...(existing.frontmatter.source_obs_ids ?? []), item.observation_id]),
        carrier_refs: canonicalList(existing.frontmatter.carrier_refs ?? []),
      };
      if (!preserveBody) {
        nextRecord.authority = item.knowledge.authority;
        nextRecord.confidence = item.knowledge.confidence;
        op.result_reason = "compile_update";
        op.body_action = item.body_action ?? "updated";
        op.update_scope = item.update_scope;
      } else {
        op.body_action = "preserved";
        op.update_scope = "evidence_scope_refresh";
        op.result_reason = "human_logged_update; compile_update preserved the current body";
        if (item.knowledge.body.trim() !== existing.body.trim()) {
          const bodyProposal = proposalBundle(root, {
            carrierType: "markdown_document",
            targetPath: existing.path,
            targetBytes: Buffer.from(existing.text, "utf8"),
            candidateBytes: Buffer.from(renderKnowledgeCanonical(nextRecord, item.knowledge.body, false), "utf8"),
            sourceKnIds: [knId],
            sourceRefs: [item.observation_id],
            extension: "md",
          });
          op.writes.push(...bodyProposal.writes);
          op.action_names.push("propose_body_update");
        }
      }
      desired.set(knId, { record: nextRecord, body: preserveBody ? existing.body : item.knowledge.body, preserve: preserveBody, owner: op });
      ownerByKn.set(knId, op);
      op.action_names.push("update_knowledge");
      op.archive_args = ["--observation", item.observation_id, "--compiled-to-kn", knId];
    } else if (item.disposition === "merge") {
      const survivor = knowledgeFile(root, knId);
      const losers = item.merge?.loser_ids ?? item.merge?.losers ?? item.merge?.entries;
      if (!Array.isArray(losers) || losers.length === 0) fail(`merge ${knId} requires merge.loser_ids`);
      const loserRecords = losers.map((id) => knowledgeFile(root, id));
      let merged = { ...survivor.frontmatter };
      for (const loser of loserRecords) {
        merged.evidence = canonicalEvidence([...(merged.evidence ?? []), ...(loser.frontmatter.evidence ?? [])]);
        merged.scope = canonicalScope(merged.scope, loser.frontmatter.scope);
        merged.source_obs_ids = canonicalList([...(merged.source_obs_ids ?? []), ...(loser.frontmatter.source_obs_ids ?? [])]);
        merged.carrier_refs = canonicalList([...(merged.carrier_refs ?? []), ...(loser.frontmatter.carrier_refs ?? [])]);
      }
      merged.evidence = canonicalEvidence([...(merged.evidence ?? []), ...(observation.evidence ?? [])]);
      merged.source_obs_ids = canonicalList([...(merged.source_obs_ids ?? []), item.observation_id]);
      const prior = merged.supersedes === null || merged.supersedes === undefined ? [] : Array.isArray(merged.supersedes) ? merged.supersedes : [merged.supersedes];
      merged.supersedes = canonicalList([...prior, ...losers]);
      desired.set(knId, { record: merged, body: survivor.body, preserve: true, owner: op });
      ownerByKn.set(knId, op);
      op.action_names.push("merge_survivor");
      for (const loser of loserRecords) {
        const archived = transitionRecord(loser.frontmatter, "archived", { supersededBy: knId });
        desired.set(loser.id, { record: archived, body: loser.body, preserve: true, owner: op });
        ownerByKn.set(loser.id, op);
        op.action_names.push("archive_merge_loser");
      }
      op.archive_args = ["--observation", item.observation_id, "--verdict", "no_change"];
    } else if (["demote", "retire"].includes(item.disposition)) {
      const existing = knowledgeFile(root, knId);
      const targetState = item.disposition === "demote" ? "deprecated" : "archived";
      const updated = transitionRecord(existing.frontmatter, targetState, { regret: item.regret });
      desired.set(knId, { record: updated, body: existing.body, preserve: true, owner: op });
      ownerByKn.set(knId, op);
      op.action_names.push(item.disposition);
      op.archive_args = ["--observation", item.observation_id, "--verdict", "no_change"];
    } else {
      op.action_names.push("no_change");
      op.archive_args = ["--observation", item.observation_id, "--verdict", "no_change"];
    }
  }

  for (const carrierPlan of carrierPlans.values()) {
    for (const knId of carrierPlan.sourceIds) {
      const current = desired.get(knId) ?? (() => {
        const entry = knowledgeFile(root, knId);
        return { record: { ...entry.frontmatter }, body: entry.body, preserve: true, owner: null };
      })();
      current.record.carrier_refs = canonicalList([...(current.record.carrier_refs ?? []), carrierPlan.carrierRef]);
      desired.set(knId, current);
    }
  }

  const operations = itemPlans.map(({ op }) => op);
  const firstCarrierOp = operations.find((operation) => operation.artifact_id !== null) ?? operations[0];
  for (const [id, value] of desired) {
    const existingFile = host.listFiles(paths.knowledge, ".md").find((candidate) => {
      const name = path.basename(candidate);
      return name === `${id}.md` || name.startsWith(`${id}-`);
    });
    const existing = existingFile ? knowledgeFile(root, id) : null;
    const target = existing ? existing.path : portableRelative(root, path.join(paths.knowledge, host.knowledgeFilename(id, value.record.claim)));
    const before = existing?.text ?? null;
    const write = operationWrite(root, target, renderKnowledgeCanonical(value.record, value.body, value.preserve), before === null ? null : sha256(Buffer.from(before, "utf8")));
    const owner = value.owner ?? firstCarrierOp;
    owner.writes.push(write);
  }
  for (const [artifactId, carrierPlan] of carrierPlans) {
    const owner = carrierPlan.request.items[0].op;
    owner.artifact_id = artifactId;
    owner.writes.push(...carrierPlan.writes);
    owner.action_names.push(carrierPlan.updatedSidecar.status === "proposed" ? "write_proposal_bundle" : "update_carrier");
  }
  for (const op of operations) {
    if (op.queue) {
      op.writes.push(operationWrite(root, op.queue.path, op.queue.expected_text));
      op.action_names.push("write_queue");
    }
    const mergedWrites = new Map();
    for (const write of op.writes) {
      const previous = mergedWrites.get(write.path);
      if (previous && previous.expected_text !== write.expected_text) fail(`compile transaction has conflicting writes for ${write.path}`);
      if (!previous) mergedWrites.set(write.path, write);
    }
    op.writes = [...mergedWrites.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (op.action_names.length === 0) op.action_names.push("archive_observation");
  }
  const humanByEntry = new Map();
  for (const planItem of itemPlans) {
    if (planItem.item.disposition === "update") humanByEntry.set(planItem.knId, currentHumanLoggedUpdate(root, planItem.knId));
  }
  const humanActions = [...humanByEntry.values()].flat();
  const report = buildV2Report({ value: planDigest, root }, context.context_digest, now, operations, humanActions);
  const journal = {
    kind: "kg.compile_transaction",
    version: 2,
    plan_digest: planDigest,
    context_digest: context.context_digest,
    generated_at: now.toISOString(),
    report_path: portableRelative(root, reportPathFor(paths, planDigest)),
    operations,
    report,
  };
  return { ...journal, journal_digest: sha256(Buffer.from(JSON.stringify(journal), "utf8")) };
}

function reportPathFor(paths, planDigest) {
  return path.join(paths.reports, `COMPILE-${planDigest.slice(0, 16)}.json`);
}

function journalPathFor(paths, planDigest) {
  return path.join(paths.reports, `.compile-transaction-${planDigest.slice(0, 16)}.json`);
}

function reservationFromJournal(root, journal, planDigest, contextDigest, now) {
  const knowledgeIds = journal.operations
    .map((operation) => operation.kn_id)
    .filter((id) => /^KN-[0-9]{4}$/.test(id))
    .sort();
  const queueIds = journal.operations
    .map((operation) => operation.queue?.id)
    .filter((id) => /^Q-[0-9]{8}-[0-9]{3}$/.test(id))
    .sort();
  const proposalIds = journal.operations
    .flatMap((operation) => operation.writes ?? [])
    .map((write) => write.expected_text)
    .flatMap((text) => {
      const matches = [...String(text).matchAll(/"proposal_id": "(compile-[a-z0-9][a-z0-9._-]*)"/g)];
      return matches.map((match) => match[1]);
    })
    .sort();
  const range = (ids, key) => ids.length === 0
    ? { start: null, end: null, count: 0 }
    : { start: ids[0], end: ids.at(-1), count: ids.length };
  const queueDay = queueIds[0]?.slice(2, 10) ?? now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    kind: "kg.compile_id_reservation",
    version: 1,
    plan_digest: planDigest,
    context_digest: contextDigest,
    now: now.toISOString(),
    allocation: {
      knowledge: range(knowledgeIds, "knowledge"),
      queue: { day: queueDay, ...range(queueIds, "queue") },
      proposals: { ids: [...new Set(proposalIds)], count: [...new Set(proposalIds)].length },
    },
    path: `.kg/ids/reservations/${planDigest}.json`,
  };
}

function sealJournal(journal) {
  const { journal_digest: _oldDigest, ...unsigned } = journal;
  return {
    ...unsigned,
    journal_digest: sha256(Buffer.from(JSON.stringify(unsigned), "utf8")),
  };
}

function reserveIdsExclusive(paths, reservation) {
  const directory = reservationDirectory(paths);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${reservation.plan_digest}.json`);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(reservation)) {
      fail(`durable ID reservation conflicts with existing plan: ${reservation.plan_digest}`);
    }
    return file;
  }
  const occupied = readDurableReservations(paths).filter((item) => item.plan_digest !== reservation.plan_digest);
  const newKnowledge = reservation.allocation.knowledge;
  const newQueue = reservation.allocation.queue;
  const knowledgeConflict = newKnowledge.start && rangesOverlap(
    numericPart(newKnowledge.start, "KN-"),
    numericPart(newKnowledge.end, "KN-"),
    occupied.map((item) => item.allocation?.knowledge).filter((range) => range?.start && range?.end).map((range) => ({
      start: numericPart(range.start, "KN-"),
      end: numericPart(range.end, "KN-"),
    })),
  );
  const queueConflict = newQueue.start && rangesOverlap(
    numericPart(newQueue.start, `Q-${newQueue.day}-`),
    numericPart(newQueue.end, `Q-${newQueue.day}-`),
    occupied.map((item) => item.allocation?.queue).filter((range) => range?.day === newQueue.day && range.start && range.end).map((range) => ({
      start: numericPart(range.start, `Q-${newQueue.day}-`),
      end: numericPart(range.end, `Q-${newQueue.day}-`),
    })),
  );
  if (knowledgeConflict || queueConflict) fail("durable ID reservation overlaps an existing reservation");
  const text = `${JSON.stringify(reservation, null, 2)}\n`;
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") fail(`durable ID reservation was claimed concurrently: ${reservation.plan_digest}`);
    throw error;
  }
  return file;
}

function actionResult(operation) {
  const disposition =
    operation.result_type === "publish_kn_and_carrier"
      ? "add"
      : operation.result_type === "queue_only"
        ? "candidate"
        : "no_change";
  const actionId = `ACT-${sha256(Buffer.from(`${operation.observation_id}:${operation.result_type}:${operation.observation_sha256}`, "utf8")).slice(0, 16)}`;
  if (operation.result_type === "publish_kn_and_carrier") {
    return {
      action_id: actionId,
      observation_id: operation.observation_id,
      disposition,
      actor: "compile",
      update_scope: "full",
      body_action: "updated",
      source_observation_sha256: operation.observation_sha256,
      target_kn_id: operation.kn.id,
      artifact_id: operation.carrier.artifact_id,
      result_reason: operation.result_reason,
      actions: ["create_kn", "update_carrier", "update_sidecar", "archive_observation"],
    };
  }
  if (operation.result_type === "queue_only") {
    return {
      action_id: actionId,
      observation_id: operation.observation_id,
      disposition,
      actor: "compile",
      update_scope: "proposal_only",
      body_action: "preserved",
      source_observation_sha256: operation.observation_sha256,
      target_kn_id: null,
      artifact_id: null,
      result_reason: operation.result_reason,
      actions: ["create_queue_item", "archive_observation"],
    };
  }
  return {
    action_id: actionId,
    observation_id: operation.observation_id,
    disposition,
    actor: "compile",
    update_scope: "full",
    body_action: "preserved",
    source_observation_sha256: operation.observation_sha256,
    target_kn_id: null,
    artifact_id: null,
    result_reason: operation.result_reason,
    actions: ["archive_observation"],
  };
}

function buildReport(planDigest, contextDigest, now, operations) {
  const results = {
    publish_kn_and_carrier: [],
    queue_only: [],
    no_change: [],
  };
  for (const operation of operations) results[operation.result_type].push(actionResult(operation));
  return {
    kind: "kg.compile_report",
    version: 2,
    plan_digest: planDigest,
    context_digest: contextDigest,
    generated_at: now.toISOString(),
    known_limitations: KNOWN_LIMITATIONS,
    results,
    actions: operations.map(actionResult),
    archives: operations.map((operation) => ({
      observation_id: operation.observation_id,
      arguments: operation.archive_args,
    })),
  };
}

function buildFreshJournal(root, context, plan, planDigest, now) {
  if (plan.version === 2) {
    return buildFreshJournalV2(root, context, plan, planDigest, now);
  }
  const paths = host.kgPaths(root);
  validateCurrentInverseMap(root);
  const observationInputs = new Map(context.observations.map((input) => [input.id, input]));
  const artifactInputs = new Map(context.artifacts.map((input) => [input.artifact_id, input]));
  const firstKnId = host.nextKnowledgeId(paths);
  const queueIds = nextQueueIds(paths, plan.items.filter((item) => item.result_type === "queue_only").length, now);
  let knOffset = 0;
  let queueOffset = 0;
  const usedArtifacts = new Set();
  const operations = [];

  for (const item of plan.items) {
    const input = observationInputs.get(item.observation_id);
    if (!input) fail(`plan observation was not present in compile context: ${item.observation_id}`);
    const observation = readObservation(root, input);
    if (!fs.existsSync(observation.pending)) {
      fail(`fresh compile preflight requires a pending observation: ${item.observation_id}`);
    }
    if (fs.existsSync(observation.processed)) {
      fail(`processed observation target already exists: ${item.observation_id}`);
    }
    if (observation.record.compiled_to_kn !== undefined && observation.record.compiled_to_kn !== null) {
      fail(`pending observation already has compiled_to_kn: ${item.observation_id}`);
    }
    const base = {
      observation_id: item.observation_id,
      observation_path: input.path,
      observation_sha256: input.sha256,
      result_type: item.result_type,
      result_reason:
        item.result_type === "no_change"
          ? item.reason
          : item.result_type === "queue_only"
            ? item.queue.recommendation
            : `Publish one active project_knowledge entry to ${item.carrier.artifact_id}.`,
    };

    if (item.result_type === "publish_kn_and_carrier") {
      const artifact = artifactInputs.get(item.carrier.artifact_id);
      if (!artifact) fail(`carrier artifact was not present in compile context: ${item.carrier.artifact_id}`);
      if (usedArtifacts.has(artifact.artifact_id)) fail(`carrier artifact is repeated: ${artifact.artifact_id}`);
      usedArtifacts.add(artifact.artifact_id);
      const policyRegion = protocol.loadRouting().ownership_update_matrix?.[artifact.ownership]?.[artifact.update_policy];
      if (policyRegion === "none") fail(`compile carrier has no compile-owned region: ${artifact.artifact_id}`);
      if (policyRegion === "reject" || policyRegion === undefined) {
        fail(`compile carrier ownership/update_policy is rejected: ${artifact.artifact_id}`);
      }
      if (policyRegion !== "machine_block") fail(`compile carrier policy is not an automatic managed block: ${artifact.artifact_id}`);
      const sidecarFile = harness.resolveCompileInput(root, artifact.sidecar_path).full;
      const targetFile = harness.resolveCompileInput(root, artifact.target_path).full;
      const sidecar = harness.readHarnessSidecar(root, sidecarFile);
      harness.validateHarnessReferences(root, sidecar);
      if (sidecar.source_kn_ids.length !== 0) fail(`M2 carrier must start with no source_kn_ids: ${artifact.artifact_id}`);
      const beforeDocument = fs.readFileSync(targetFile, "utf8");
      const beforeBlock = harness.inspectManagedBlock(beforeDocument, artifact.artifact_id);
      const knId = incrementKnId(firstKnId, knOffset);
      knOffset += 1;
      const carrierRef = inverseMap.carrierRefForSidecar(sidecar, { root });
      const record = {
        id: knId,
        claim: item.knowledge.claim,
        category: item.knowledge.category,
        scope: item.knowledge.scope,
        evidence: [{ type: "observation", ref: item.observation_id }],
        authority: item.knowledge.authority,
        confidence: item.knowledge.confidence,
        lifecycle: "active",
        supersedes: null,
        last_verified: now.toISOString().slice(0, 10),
        regret: null,
        source_obs_ids: [item.observation_id],
        carrier_refs: [carrierRef],
      };
      const knPath = path.join(paths.knowledge, host.knowledgeFilename(knId, record.claim));
      const expectedKnText = renderKnowledge(record, item.knowledge.body);
      const draftText = [
        "---",
        kyaml.stringify({
          claim: record.claim,
          category: record.category,
          scope: record.scope,
          evidence: record.evidence,
          authority: record.authority,
          confidence: record.confidence,
          supersedes: null,
          last_verified: record.last_verified,
          source_obs_ids: record.source_obs_ids,
          carrier_refs: record.carrier_refs,
        }).trimEnd(),
        "---",
        "",
        item.knowledge.body.trim(),
        "",
      ].join("\n");
      const renderedContent = `<!-- kg:source ${knId} -->\n${item.carrier.content.trim()}`;
      const afterDocument = harness.replaceManagedBlock(beforeDocument, artifact.artifact_id, renderedContent);
      const afterBlock = harness.inspectManagedBlock(afterDocument, artifact.artifact_id);
      harness.assertTransactionByteFence(beforeBlock, afterBlock);
      const updatedSidecar = {
        ...sidecar,
        source_kn_ids: [knId],
        content_hash: afterBlock.contentHash,
        machine_segment_hash: afterBlock.machine_segment_hash,
        human_segment_hash: afterBlock.human_segment_hash,
        outside_hash: afterBlock.outside_hash,
        generator_version: "kg-compile/2.0.0-m2",
        last_verified: now.toISOString().slice(0, 10),
      };
      const sidecarText = harness.renderHarnessSidecar(updatedSidecar);
      harness.validateHarnessReferences(root, updatedSidecar);
      operations.push({
        ...base,
        kn: {
          id: knId,
          path: portableRelative(root, knPath),
          draft_text: draftText,
          expected_text: expectedKnText,
        },
        carrier: {
          artifact_id: artifact.artifact_id,
          path: artifact.target_path,
          before_sha256: artifact.target_sha256,
          expected_text: afterDocument,
          content_hash: afterBlock.contentHash,
          outside_hash: beforeBlock.outsideHash,
          prefix_sha256: beforeBlock.prefix_sha256,
          suffix_sha256: beforeBlock.suffix_sha256,
          human_segment_hash: beforeBlock.human_segment_hash,
          machine_segment_hash: afterBlock.machine_segment_hash,
        },
        sidecar: {
          path: artifact.sidecar_path,
          before_sha256: artifact.sha256,
          expected_text: sidecarText,
        },
        archive_args: ["--observation", item.observation_id, "--compiled-to-kn", knId],
      });
    } else if (item.result_type === "queue_only") {
      const id = queueIds[queueOffset];
      queueOffset += 1;
      operations.push({
        ...base,
        queue: {
          id,
          path: portableRelative(root, path.join(paths.queue, `${id}.yaml`)),
          draft_text: kyaml.stringify({
            kind: "conflict",
            category: "needs_human_decision",
            claim: item.queue.claim,
            evidence: item.queue.evidence,
            options: item.queue.options,
            recommendation: item.queue.recommendation,
            source_observations: [item.observation_id],
          }),
          expected_text: renderQueueRecord(id, now, item.queue, item.observation_id),
        },
        archive_args: ["--observation", item.observation_id, "--verdict", "needs_human_decision"],
      });
    } else {
      operations.push({
        ...base,
        archive_args: ["--observation", item.observation_id, "--verdict", "no_change"],
      });
    }
  }

  const report = buildReport(planDigest, context.context_digest, now, operations);
  const journal = {
    kind: "kg.compile_transaction",
    version: 1,
    plan_digest: planDigest,
    context_digest: context.context_digest,
    generated_at: now.toISOString(),
    report_path: portableRelative(root, reportPathFor(paths, planDigest)),
    operations,
    report,
  };
  return { ...journal, journal_digest: sha256(Buffer.from(JSON.stringify(journal), "utf8")) };
}

function validateCurrentInverseMap(root) {
  const paths = host.kgPaths(root);
  const knowledgeEntries = host
    .listFiles(paths.knowledge, ".md")
    .map((file) => protocol.splitFrontmatter(fs.readFileSync(file, "utf8")).frontmatter);
  const carriers = host
    .listFiles(path.join(root, "harness", "artifacts"), ".yaml")
    .map((file) => harness.readHarnessSidecar(root, file));
  const result = inverseMap.validateInverseMap({ knowledgeEntries, carriers, root });
  const error = result.findings.find((finding) => finding.severity === "error");
  if (error) fail(`inverse map preflight failed: ${error.issue}`);
  return result;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.kg-compile-write.tmp`);
  try {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertMissingOrExpected(file, expectedText, label) {
  if (!fs.existsSync(file)) return "missing";
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail(`${label} is not a regular file`);
  if (fs.readFileSync(file, "utf8") !== expectedText) fail(`${label} exists with unexpected content`);
  return "expected";
}

function assertBaselineOrExpected(file, beforeSha, expectedText, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    fail(`${label} is not a regular file`);
  }
  const text = fs.readFileSync(file, "utf8");
  const digest = sha256(Buffer.from(text));
  if (digest === beforeSha) return "baseline";
  if (text === expectedText) return "expected";
  fail(`${label} differs from both the preflight input and expected output`);
}

function runWriter(script, args, root, input) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, KG_ROOT: root },
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${path.basename(script)} failed with exit ${result.status}: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  }
  return result;
}

function processedExpected(operation) {
  const inputPath = operation.observation_path;
  return { pending: inputPath, processed: `.kg/observations/processed/${operation.observation_id}.yaml` };
}

function operationWriteFile(root, relative) {
  const file = path.resolve(root, ...String(relative).split("/"));
  if (host.isOutside(root, file)) fail(`compile transaction path escapes host root: ${relative}`);
  return file;
}

function validateV2WriteState(root, write) {
  const file = operationWriteFile(root, write.path);
  if (!fs.existsSync(file)) {
    if (write.before_sha256 !== null) fail(`v2 transaction target disappeared: ${write.path}`);
    return "baseline-missing";
  }
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail(`v2 transaction target is unsafe: ${write.path}`);
  const text = fs.readFileSync(file, "utf8");
  if (text === write.expected_text) return "expected";
  if (write.before_sha256 !== null && sha256(Buffer.from(text, "utf8")) === write.before_sha256) return "baseline";
  fail(`v2 transaction target differs from both baseline and expected output: ${write.path}`);
}

function validateV2OperationState(root, operation, { final }) {
  const inputPath = operationWriteFile(root, operation.observation_path);
  const processed = operationWriteFile(root, `.kg/observations/processed/${operation.observation_id}.yaml`);
  if (final) {
    if (fs.existsSync(inputPath)) fail(`pending observation remains after compile: ${operation.observation_id}`);
    if (!fs.existsSync(processed)) fail(`processed observation missing after compile: ${operation.observation_id}`);
    const processedRecord = kyaml.parse(fs.readFileSync(processed, "utf8"));
    if (operation.kn_id && processedRecord.compiled_to_kn !== operation.kn_id) {
      fail(`processed observation KN link mismatch: ${operation.observation_id}`);
    }
    if (!operation.kn_id && processedRecord.compiled_to_kn !== undefined && processedRecord.compiled_to_kn !== null) {
      fail(`no-KN v2 action unexpectedly wrote compiled_to_kn: ${operation.observation_id}`);
    }
  } else if (fs.existsSync(inputPath)) {
    if (sha256(fs.readFileSync(inputPath)) !== operation.observation_sha256) fail(`pending observation changed: ${operation.observation_id}`);
  } else if (!fs.existsSync(processed)) {
    fail(`v2 observation is neither pending nor processed: ${operation.observation_id}`);
  }
  for (const write of operation.writes) validateV2WriteState(root, write);
}

function validateOperationState(root, operation, { final }) {
  if (operation.protocol_version === 2) {
    validateV2OperationState(root, operation, { final });
    return;
  }
  const state = processedExpected(operation);
  const pending = path.join(root, ...state.pending.split("/"));
  const processed = path.join(root, ...state.processed.split("/"));
  if (final) {
    if (fs.existsSync(pending)) fail(`pending observation remains after compile: ${operation.observation_id}`);
    if (!fs.existsSync(processed)) fail(`processed observation missing after compile: ${operation.observation_id}`);
    const record = kyaml.parse(fs.readFileSync(processed, "utf8"));
    const expectedKn = operation.result_type === "publish_kn_and_carrier" ? operation.kn.id : undefined;
    if (expectedKn && record.compiled_to_kn !== expectedKn) {
      fail(`processed observation compiled_to_kn mismatch for ${operation.observation_id}`);
    }
    if (!expectedKn && record.compiled_to_kn !== undefined && record.compiled_to_kn !== null) {
      fail(`no-KN observation unexpectedly has compiled_to_kn: ${operation.observation_id}`);
    }
  } else if (fs.existsSync(pending)) {
    if (sha256(fs.readFileSync(pending)) !== operation.observation_sha256) {
      fail(`pending observation changed after preflight: ${operation.observation_id}`);
    }
  } else if (!fs.existsSync(processed)) {
    fail(`observation is neither pending nor processed: ${operation.observation_id}`);
  }

  if (operation.result_type === "publish_kn_and_carrier") {
    const knFile = path.join(root, ...operation.kn.path.split("/"));
    const carrierFile = path.join(root, ...operation.carrier.path.split("/"));
    const sidecarFile = path.join(root, ...operation.sidecar.path.split("/"));
    if (final) {
      assertMissingOrExpected(knFile, operation.kn.expected_text, `knowledge ${operation.kn.id}`);
      if (!fs.existsSync(knFile)) fail(`knowledge entry missing after compile: ${operation.kn.id}`);
      assertBaselineOrExpected(
        carrierFile,
        operation.carrier.before_sha256,
        operation.carrier.expected_text,
        `carrier ${operation.carrier.artifact_id}`,
      );
      if (fs.readFileSync(carrierFile, "utf8") !== operation.carrier.expected_text) {
        fail(`carrier was not updated: ${operation.carrier.artifact_id}`);
      }
      assertBaselineOrExpected(
        sidecarFile,
        operation.sidecar.before_sha256,
        operation.sidecar.expected_text,
        `sidecar ${operation.carrier.artifact_id}`,
      );
      if (fs.readFileSync(sidecarFile, "utf8") !== operation.sidecar.expected_text) {
        fail(`sidecar was not updated: ${operation.carrier.artifact_id}`);
      }
      const sidecar = harness.readHarnessSidecar(root, sidecarFile);
      const block = harness.inspectManagedBlock(fs.readFileSync(carrierFile, "utf8"), sidecar.artifact_id);
      if (sidecar.content_hash !== block.contentHash) fail(`final managed block hash mismatch: ${sidecar.artifact_id}`);
      if (sidecar.machine_segment_hash !== block.machine_segment_hash) fail(`final machine segment hash mismatch: ${sidecar.artifact_id}`);
      if (sidecar.outside_hash !== block.outside_hash) fail(`final outside hash mismatch: ${sidecar.artifact_id}`);
      if (JSON.stringify(sidecar.source_kn_ids) !== JSON.stringify([operation.kn.id])) {
        fail(`final sidecar source_kn_ids mismatch: ${sidecar.artifact_id}`);
      }
      const { frontmatter: knowledge } = protocol.splitFrontmatter(fs.readFileSync(knFile, "utf8"));
      if (
        JSON.stringify(knowledge.carrier_refs) !==
        JSON.stringify([inverseMap.carrierRefForSidecar(sidecar, { root })])
      ) {
        fail(`knowledge entry carrier_refs missing: ${operation.kn.id}`);
      }
    } else {
      assertMissingOrExpected(knFile, operation.kn.expected_text, `knowledge ${operation.kn.id}`);
      assertBaselineOrExpected(
        carrierFile,
        operation.carrier.before_sha256,
        operation.carrier.expected_text,
        `carrier ${operation.carrier.artifact_id}`,
      );
      assertBaselineOrExpected(
        sidecarFile,
        operation.sidecar.before_sha256,
        operation.sidecar.expected_text,
        `sidecar ${operation.carrier.artifact_id}`,
      );
    }
  }
  if (operation.result_type === "queue_only") {
    const queueFile = path.join(root, ...operation.queue.path.split("/"));
    assertMissingOrExpected(queueFile, operation.queue.expected_text, `queue item ${operation.queue.id}`);
    if (final && !fs.existsSync(queueFile)) fail(`queue item missing after compile: ${operation.queue.id}`);
  }
}

function preflightWritable(root, journal) {
  const paths = host.kgPaths(root);
  const directories = new Set([paths.processed, paths.reports]);
  if (journal.version === 2) directories.add(reservationDirectory(paths));
  for (const operation of journal.operations) {
    if (operation.protocol_version === 2) {
      for (const write of operation.writes) directories.add(path.dirname(operationWriteFile(root, write.path)));
    }
    if (operation.kn) directories.add(paths.knowledge);
    if (operation.queue) directories.add(paths.queue);
    if (operation.carrier) directories.add(path.dirname(path.join(root, ...operation.carrier.path.split("/"))));
    if (operation.sidecar) directories.add(path.dirname(path.join(root, ...operation.sidecar.path.split("/"))));
  }
  for (const directory of directories) {
    let probe = directory;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) fail(`required compile output directory has no writable ancestor: ${portableRelative(root, directory)}`);
      probe = parent;
    }
    if (!fs.statSync(probe).isDirectory() || fs.lstatSync(probe).isSymbolicLink()) {
      fail(`required compile output directory is unsafe: ${portableRelative(root, probe)}`);
    }
    fs.accessSync(probe, fs.constants.R_OK | fs.constants.W_OK);
  }
  if (process.env.KG_COMPILE_FAIL_PREFLIGHT === "kn_write") fail("injected KN write preflight failure");
  if (process.env.KG_COMPILE_FAIL_PREFLIGHT === "carrier_write") fail("injected carrier write preflight failure");
  const reportFile = path.join(root, ...journal.report_path.split("/"));
  if (fs.existsSync(reportFile)) fail(`compile report already exists without a valid completed transaction: ${journal.report_path}`);
}

function applyJournal(root, journal, now) {
  for (const operation of journal.operations) validateOperationState(root, operation, { final: false });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kg-compile-apply-"));
  try {
    for (const operation of journal.operations) {
      if (operation.protocol_version === 2) {
        for (const write of operation.writes) {
          const file = operationWriteFile(root, write.path);
          if (validateV2WriteState(root, write) === "expected") continue;
          atomicWrite(file, write.expected_text);
          if (process.env.KG_COMPILE_FAIL_AFTER === "v2_write") fail("injected failure after v2 write");
        }
      } else if (operation.result_type === "publish_kn_and_carrier") {
        const knFile = path.join(root, ...operation.kn.path.split("/"));
        if (!fs.existsSync(knFile)) {
          const draft = path.join(scratch, `${operation.kn.id}.md`);
          fs.writeFileSync(draft, operation.kn.draft_text);
          runWriter(ADD_ENTRY, [draft], root);
          if (!fs.existsSync(knFile) || fs.readFileSync(knFile, "utf8") !== operation.kn.expected_text) {
            fail(`add-entry.mjs did not create expected knowledge ${operation.kn.id}`);
          }
          if (process.env.KG_COMPILE_FAIL_AFTER === "kn_write") {
            fail("injected failure after KN write");
          }
        }
        const carrierFile = path.join(root, ...operation.carrier.path.split("/"));
        if (fs.readFileSync(carrierFile, "utf8") !== operation.carrier.expected_text) {
          atomicWrite(carrierFile, operation.carrier.expected_text);
          if (process.env.KG_COMPILE_FAIL_AFTER === "carrier_write") {
            fail("injected failure after carrier write");
          }
        }
        const sidecarFile = path.join(root, ...operation.sidecar.path.split("/"));
        if (fs.readFileSync(sidecarFile, "utf8") !== operation.sidecar.expected_text) {
          atomicWrite(sidecarFile, operation.sidecar.expected_text);
        }
      } else if (operation.result_type === "queue_only") {
        const queueFile = path.join(root, ...operation.queue.path.split("/"));
        if (!fs.existsSync(queueFile)) {
          runWriter(
            ADD_QUEUE_ITEM,
            ["--stdin", "--now", now.toISOString()],
            root,
            operation.queue.draft_text,
          );
          if (!fs.existsSync(queueFile) || fs.readFileSync(queueFile, "utf8") !== operation.queue.expected_text) {
            fail(`add-queue-item.mjs did not create expected queue item ${operation.queue.id}`);
          }
        }
      }
    }

    // Product writes are validated from the post-write filesystem before any
    // observation is archived. This keeps the archive as the final product
    // transition and makes a partial product impossible to report as done.
    for (const operation of journal.operations) validateOperationState(root, operation, { final: false });
    validateCurrentInverseMap(root);
    for (const operation of journal.operations) runWriter(ARCHIVE_OBSERVATION, operation.archive_args, root);
    for (const operation of journal.operations) validateOperationState(root, operation, { final: true });
    validateCurrentInverseMap(root);
    const paths = host.kgPaths(root);
    const roundLog = host.roundLogFile(paths);
    if (fs.existsSync(roundLog)) fs.unlinkSync(roundLog);
    const reportFile = path.join(root, ...journal.report_path.split("/"));
    atomicWriteJson(reportFile, journal.report);
    return reportFile;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function loadJournal(root, file, planDigest, contextDigest, nowValue = null) {
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`compile transaction journal is invalid: ${error.message}`);
  }
  const planSchema = protocol.loadCompilePlanSchema();
  const legacyVersions = Array.isArray(planSchema.legacy_versions) ? planSchema.legacy_versions : [];
  const supportedVersions = new Set([planSchema.version, ...legacyVersions]);
  const versionSupported = supportedVersions.has(journal?.version);
  const legacyResultTypes = new Set(Object.keys(planSchema.legacy_item_fields ?? {}));
  const operationsMatchVersion = versionSupported && (
    journal.version === planSchema.version
      ? journal.operations?.every((operation) => operation?.protocol_version === planSchema.version && Array.isArray(operation.writes))
      : journal.operations?.every((operation) => operation?.protocol_version === undefined && legacyResultTypes.has(operation?.result_type))
  );
  if (
    journal?.kind !== "kg.compile_transaction" ||
    !versionSupported ||
    journal.plan_digest !== planDigest ||
    journal.context_digest !== contextDigest ||
    !Array.isArray(journal.operations) ||
    journal.operations.length === 0 ||
    !operationsMatchVersion ||
    journal.report?.plan_digest !== planDigest ||
    typeof journal.journal_digest !== "string"
  ) {
    fail("compile transaction journal does not match the plan/context");
  }
  if (journal.version === 2) {
    const reservation = journal.reservation;
    if (
      reservation?.kind !== "kg.compile_id_reservation" ||
      reservation.plan_digest !== planDigest ||
      reservation.context_digest !== contextDigest ||
      (nowValue && reservation.now !== nowValue.toISOString()) ||
      reservation.path !== `.kg/ids/reservations/${planDigest}.json`
    ) {
      fail("compile transaction journal reservation does not match the plan/context/now");
    }
    const reservationFile = path.join(root, ...reservation.path.split("/"));
    if (!fs.existsSync(reservationFile)) fail("compile transaction durable reservation is missing");
    let storedReservation;
    try {
      storedReservation = JSON.parse(fs.readFileSync(reservationFile, "utf8"));
    } catch (error) {
      fail(`compile transaction durable reservation is invalid: ${error.message}`);
    }
    if (JSON.stringify(storedReservation) !== JSON.stringify(reservation)) {
      fail("compile transaction durable reservation differs from the journal");
    }
    if (JSON.stringify(journal.report?.reservation) !== JSON.stringify(reservation)) {
      fail("compile report reservation differs from the journal");
    }
  }
  const { journal_digest: declaredDigest, ...unsigned } = journal;
  if (declaredDigest !== sha256(Buffer.from(JSON.stringify(unsigned), "utf8"))) {
    fail("compile transaction journal digest mismatch");
  }
  const expectedReport = portableRelative(root, reportPathFor(host.kgPaths(root), planDigest));
  if (journal.report_path !== expectedReport) fail("compile transaction report_path is invalid");
  for (const operation of journal.operations) {
    if (operation.observation_path !== `.kg/observations/${operation.observation_id}.yaml`) {
      fail(`compile transaction observation_path is invalid: ${operation.observation_id}`);
    }
    harness.resolveCompileInput(root, operation.observation_path, { mustExist: false });
    if (operation.kn) {
      if (!operation.kn.path.startsWith(`knowledge/${operation.kn.id}-`)) fail("compile transaction KN path is invalid");
      harness.resolveCompileInput(root, operation.kn.path, { mustExist: false });
    }
    if (operation.queue) {
      if (operation.queue.path !== `.kg/queue/${operation.queue.id}.yaml`) fail("compile transaction queue path is invalid");
      harness.resolveCompileInput(root, operation.queue.path, { mustExist: false });
    }
    if (operation.carrier) harness.resolveCompileInput(root, operation.carrier.path);
    if (operation.sidecar) {
      if (!operation.sidecar.path.startsWith("harness/artifacts/")) fail("compile transaction sidecar path is invalid");
      harness.resolveCompileInput(root, operation.sidecar.path);
    }
  }
  return journal;
}

function validateCompleted(root, reportFile, planDigest, context) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  } catch (error) {
    fail(`compile report is invalid: ${error.message}`);
  }
  if (
    report?.kind !== "kg.compile_report" ||
    report?.version !== 2 ||
    report.plan_digest !== planDigest ||
    report.context_digest !== context.context_digest ||
    host.canonicalPath(context.host_root) !== host.canonicalPath(root) ||
    JSON.stringify(report.known_limitations) !== JSON.stringify(KNOWN_LIMITATIONS)
  ) {
    fail("compile report does not match the requested plan or known limitations");
  }
  const reportErrors = protocol.validateRecord(report, protocol.loadCompileReportSchema());
  if (reportErrors.length) fail(`compile report schema is invalid: ${reportErrors.join("; ")}`);
  const paths = host.kgPaths(root);
  const journalFile = journalPathFor(paths, planDigest);
  if (!fs.existsSync(journalFile)) fail("completed compile report is missing its transaction manifest");
  const journal = loadJournal(root, journalFile, planDigest, report.context_digest);
  if (JSON.stringify(journal.report) !== JSON.stringify(report)) fail("compile report differs from transaction manifest");
  for (const operation of journal.operations) validateOperationState(root, operation, { final: true });
  validateCurrentInverseMap(root);
  return report;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = host.assertSafeHostRoot(args.root);
    const loadedContext = assertExternalJson(args.context, "compile context");
    const loadedPlan = assertExternalJson(args.plan, "compile plan");
    const context = harness.validateCompileContext(loadedContext.value);
    const plan = validatePlan(loadedPlan.value);
    const planDigest = compilePlan.digestPlan(plan);
    const paths = host.kgPaths(root);
    const reportFile = reportPathFor(paths, planDigest);
    if (fs.existsSync(reportFile)) {
      validateCompleted(root, reportFile, planDigest, context);
      console.log(`kg: compile plan already applied -> ${portableRelative(root, reportFile)}`);
      return;
    }

    const journalFile = journalPathFor(paths, planDigest);
    let journal;
    if (fs.existsSync(journalFile)) {
      journal = loadJournal(root, journalFile, planDigest, context.context_digest, args.now);
      for (const operation of journal.operations) validateOperationState(root, operation, { final: false });
    } else {
      harness.assertCompileContextCurrent(root, context);
      journal = buildFreshJournal(root, context, plan, planDigest, args.now);
      preflightWritable(root, journal);
      if (args.check) {
        console.log(`kg: compile plan preflight passed (${planDigest})`);
        return;
      }
      if (journal.version === 2) {
        const reservation = reservationFromJournal(root, journal, planDigest, context.context_digest, args.now);
        const reservationFile = path.join(root, ...reservation.path.split("/"));
        let createdReservation = false;
        try {
          createdReservation = !fs.existsSync(reservationFile);
          reserveIdsExclusive(paths, reservation);
          journal = sealJournal({
            ...journal,
            reservation,
            report: { ...journal.report, reservation },
          });
          fs.mkdirSync(paths.reports, { recursive: true });
          atomicWriteJson(journalFile, journal);
        } catch (error) {
          if (createdReservation && fs.existsSync(reservationFile) && !fs.existsSync(journalFile)) fs.rmSync(reservationFile, { force: true });
          throw error;
        }
      } else {
        fs.mkdirSync(paths.reports, { recursive: true });
        atomicWriteJson(journalFile, journal);
      }
    }
    if (args.check) {
      console.log(`kg: compile transaction is resumable (${planDigest})`);
      return;
    }
    const completedReport = applyJournal(root, journal, new Date(journal.generated_at));
    console.log(`kg: compile plan applied -> ${portableRelative(root, completedReport)}`);
  } catch (error) {
    console.error(`kg: error: ${error.message}`);
    process.exit(1);
  }
}

main();
