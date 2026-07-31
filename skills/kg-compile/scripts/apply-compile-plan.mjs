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
import { kyaml, protocol, host, harness } from "./_lib.mjs";

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
  assertExactFields(plan, PLAN_FIELDS, "compile plan");
  if (plan.kind !== "kg.compile_plan" || plan.version !== 1) fail("compile plan kind/version is invalid");
  if (!Array.isArray(plan.items) || plan.items.length === 0) fail("compile plan items must be a non-empty array");
  const observationIds = new Set();
  let publishCount = 0;
  for (const [index, item] of plan.items.entries()) {
    const label = `compile plan items[${index}]`;
    assertPlainObject(item, label);
    if (!Object.hasOwn(ITEM_FIELDS, item.result_type)) {
      fail(`${label}.result_type must be publish_kn_and_carrier | queue_only | no_change`);
    }
    assertExactFields(item, ITEM_FIELDS[item.result_type], label);
    if (!/^OBS-[0-9]{8}-[0-9]{3}$/.test(item.observation_id)) fail(`${label}.observation_id is invalid`);
    if (observationIds.has(item.observation_id)) fail(`compile plan repeats observation ${item.observation_id}`);
    observationIds.add(item.observation_id);
    if (item.result_type === "publish_kn_and_carrier") {
      publishCount += 1;
      assertExactFields(item.knowledge, KNOWLEDGE_FIELDS, `${label}.knowledge`);
      if (typeof item.knowledge.claim !== "string" || item.knowledge.claim.trim() === "") {
        fail(`${label}.knowledge.claim must be one non-empty string`);
      }
      if (item.knowledge.category !== "project_knowledge") fail(`${label}.knowledge.category must be project_knowledge in M2`);
      validateScope(item.knowledge.scope, `${label}.knowledge.scope`);
      const authorityValues = String(protocol.loadKnowledgeSchema().fields.authority.values).split("|");
      if (!authorityValues.includes(item.knowledge.authority)) fail(`${label}.knowledge.authority is invalid`);
      if (
        typeof item.knowledge.confidence !== "number" ||
        item.knowledge.confidence < 0 ||
        item.knowledge.confidence > 1
      ) {
        fail(`${label}.knowledge.confidence must be between 0 and 1`);
      }
      if (typeof item.knowledge.body !== "string" || item.knowledge.body.trim() === "") {
        fail(`${label}.knowledge.body is required`);
      }
      assertExactFields(item.carrier, CARRIER_FIELDS, `${label}.carrier`);
      if (!/^HAR-[A-Z0-9][A-Z0-9._-]*$/.test(item.carrier.artifact_id)) {
        fail(`${label}.carrier.artifact_id is invalid`);
      }
      if (typeof item.carrier.content !== "string" || item.carrier.content.trim() === "") {
        fail(`${label}.carrier.content is required`);
      }
    } else if (item.result_type === "queue_only") {
      assertExactFields(item.queue, QUEUE_FIELDS, `${label}.queue`);
      for (const field of ["claim", "recommendation"]) {
        if (typeof item.queue[field] !== "string" || item.queue[field].trim() === "") {
          fail(`${label}.queue.${field} is required`);
        }
      }
      validateEvidence(item.queue.evidence, `${label}.queue.evidence`);
      if (
        !Array.isArray(item.queue.options) ||
        item.queue.options.length < 2 ||
        !item.queue.options.every((value) => typeof value === "string" && value.trim() !== "")
      ) {
        fail(`${label}.queue.options must contain at least two non-empty strings`);
      }
    } else if (typeof item.reason !== "string" || item.reason.trim() === "") {
      fail(`${label}.reason is required`);
    }
  }
  if (publishCount > 1) fail("M2 supports at most one publish_kn_and_carrier item per plan");
  return plan;
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

function reportPathFor(paths, planDigest) {
  return path.join(paths.reports, `COMPILE-${planDigest.slice(0, 16)}.json`);
}

function journalPathFor(paths, planDigest) {
  return path.join(paths.reports, `.compile-transaction-${planDigest.slice(0, 16)}.json`);
}

function actionResult(operation) {
  if (operation.result_type === "publish_kn_and_carrier") {
    return {
      observation_id: operation.observation_id,
      source_observation_sha256: operation.observation_sha256,
      kn_id: operation.kn.id,
      artifact_id: operation.carrier.artifact_id,
      result_reason: operation.result_reason,
      actions: ["create_kn", "update_carrier", "update_sidecar", "archive_observation"],
    };
  }
  if (operation.result_type === "queue_only") {
    return {
      observation_id: operation.observation_id,
      source_observation_sha256: operation.observation_sha256,
      queue_id: operation.queue.id,
      result_reason: operation.result_reason,
      actions: ["create_queue_item", "archive_observation"],
    };
  }
  return {
    observation_id: operation.observation_id,
    source_observation_sha256: operation.observation_sha256,
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
    version: 1,
    plan_digest: planDigest,
    context_digest: contextDigest,
    generated_at: now.toISOString(),
    known_limitations: KNOWN_LIMITATIONS,
    results,
    archives: operations.map((operation) => ({
      observation_id: operation.observation_id,
      arguments: operation.archive_args,
    })),
  };
}

function buildFreshJournal(root, context, plan, planDigest, now) {
  const paths = host.kgPaths(root);
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
      if (artifact.ownership !== "managed") fail(`M2 carrier ownership must be managed: ${artifact.artifact_id}`);
      if (artifact.update_policy !== "automatic") fail(`M2 carrier update_policy must be automatic: ${artifact.artifact_id}`);
      const sidecarFile = harness.resolveCompileInput(root, artifact.sidecar_path).full;
      const targetFile = harness.resolveCompileInput(root, artifact.target_path).full;
      const sidecar = harness.readHarnessSidecar(root, sidecarFile);
      harness.validateHarnessReferences(root, sidecar);
      if (sidecar.source_kn_ids.length !== 0) fail(`M2 carrier must start with no source_kn_ids: ${artifact.artifact_id}`);
      const beforeDocument = fs.readFileSync(targetFile, "utf8");
      const beforeBlock = harness.inspectManagedBlock(beforeDocument, artifact.artifact_id);
      const knId = incrementKnId(firstKnId, knOffset);
      knOffset += 1;
      const carrierRef = `${artifact.artifact_id}@${artifact.target_path}#kg:managed`;
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
      if (beforeBlock.outsideHash !== afterBlock.outsideHash) fail(`carrier update would change content outside ${artifact.artifact_id}`);
      const updatedSidecar = {
        ...sidecar,
        source_kn_ids: [knId],
        content_hash: afterBlock.contentHash,
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

function validateOperationState(root, operation, { final }) {
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
      if (JSON.stringify(sidecar.source_kn_ids) !== JSON.stringify([operation.kn.id])) {
        fail(`final sidecar source_kn_ids mismatch: ${sidecar.artifact_id}`);
      }
      const { frontmatter: knowledge } = protocol.splitFrontmatter(fs.readFileSync(knFile, "utf8"));
      if (
        JSON.stringify(knowledge.carrier_refs) !==
        JSON.stringify([`${sidecar.artifact_id}@${sidecar.path}#kg:managed`])
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
  for (const operation of journal.operations) {
    if (operation.kn) directories.add(paths.knowledge);
    if (operation.queue) directories.add(paths.queue);
    if (operation.carrier) directories.add(path.dirname(path.join(root, ...operation.carrier.path.split("/"))));
    if (operation.sidecar) directories.add(path.dirname(path.join(root, ...operation.sidecar.path.split("/"))));
  }
  for (const directory of directories) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      fail(`required compile output directory is missing: ${portableRelative(root, directory)}`);
    }
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  }
  if (process.env.KG_COMPILE_FAIL_PREFLIGHT === "kn_write") fail("injected KN write preflight failure");
  if (process.env.KG_COMPILE_FAIL_PREFLIGHT === "carrier_write") fail("injected carrier write preflight failure");
  const reportFile = path.join(root, ...journal.report_path.split("/"));
  if (fs.existsSync(reportFile)) fail(`compile report already exists without a valid completed transaction: ${journal.report_path}`);
  if (fs.existsSync(host.roundLogFile(paths))) fail("stale compile round action log exists; resolve it before applying a new plan");
}

function applyJournal(root, journal, now) {
  for (const operation of journal.operations) validateOperationState(root, operation, { final: false });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kg-compile-apply-"));
  try {
    for (const operation of journal.operations) {
      if (operation.result_type === "publish_kn_and_carrier") {
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
      runWriter(ARCHIVE_OBSERVATION, operation.archive_args, root);
    }

    for (const operation of journal.operations) validateOperationState(root, operation, { final: true });
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

function loadJournal(root, file, planDigest, contextDigest) {
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`compile transaction journal is invalid: ${error.message}`);
  }
  if (
    journal?.kind !== "kg.compile_transaction" ||
    journal?.version !== 1 ||
    journal.plan_digest !== planDigest ||
    journal.context_digest !== contextDigest ||
    !Array.isArray(journal.operations) ||
    journal.operations.length === 0 ||
    journal.report?.plan_digest !== planDigest ||
    typeof journal.journal_digest !== "string"
  ) {
    fail("compile transaction journal does not match the plan/context");
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
    report?.version !== 1 ||
    report.plan_digest !== planDigest ||
    report.context_digest !== context.context_digest ||
    host.canonicalPath(context.host_root) !== host.canonicalPath(root) ||
    JSON.stringify(report.known_limitations) !== JSON.stringify(KNOWN_LIMITATIONS)
  ) {
    fail("compile report does not match the requested plan or known limitations");
  }
  const paths = host.kgPaths(root);
  const journalFile = journalPathFor(paths, planDigest);
  if (!fs.existsSync(journalFile)) fail("completed compile report is missing its transaction manifest");
  const journal = loadJournal(root, journalFile, planDigest, report.context_digest);
  if (JSON.stringify(journal.report) !== JSON.stringify(report)) fail("compile report differs from transaction manifest");
  for (const operation of journal.operations) validateOperationState(root, operation, { final: true });
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
    const planDigest = sha256(Buffer.from(JSON.stringify(plan), "utf8"));
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
      journal = loadJournal(root, journalFile, planDigest, context.context_digest);
      for (const operation of journal.operations) validateOperationState(root, operation, { final: false });
    } else {
      harness.assertCompileContextCurrent(root, context);
      journal = buildFreshJournal(root, context, plan, planDigest, args.now);
      preflightWritable(root, journal);
      if (args.check) {
        console.log(`kg: compile plan preflight passed (${planDigest})`);
        return;
      }
      fs.mkdirSync(paths.reports, { recursive: true });
      atomicWriteJson(journalFile, journal);
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
