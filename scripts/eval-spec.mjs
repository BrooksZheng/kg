// Provider-neutral kg-spec evaluator. M2 fixture mode replays preserved
// Runner Contract 1.1 kickoff evidence plus structured kickoff products.
// Real mode asks one agent for JSON synthesis, then delegates archive and
// lifecycle ownership to produce-spec.mjs.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "./lib/kyaml.mjs";
import * as documentAnchor from "./lib/document-anchor.mjs";
import {
  hasProductReadEvidence,
  isScriptInvocation,
  isUserInteractionToolName,
  normalizedToolName,
} from "./lib/eval-tool-audit.mjs";
import * as host from "./lib/host.mjs";
import * as machineContract from "./lib/machine-contract.mjs";
import * as protocol from "./lib/protocol.mjs";
import { loadSavedEvaluationFixture, loadSplitEvaluationFixture, scoreableOracle } from "./lib/eval-fixture.mjs";
import { buildEvaluationScore, calculateRubricScore } from "./lib/eval-rubric.mjs";
import * as productVersion from "./lib/eval-product-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCE = path.join(ROOT, "skills", "kg-spec", "scripts", "produce-spec.mjs");
const FIXED_NOW = "2026-07-31T08:00:00.000Z";
const SPEC_SYNTHESIS_SCHEMA = protocol.loadSpecSynthesisSchema();
const KICKOFF_TURN_SCHEMA = protocol.loadKickoffTurnSchema();
const KICKOFF_INDEX_SCHEMA = protocol.loadKickoffIndexSchema();
const KICKOFF_DEEP_SCHEMA = protocol.loadKickoffDeepSchema();
const REQUIRED_SECTIONS = protocol.loadTaskSpecSchema().required_sections;
const M2_FIXTURE_FIELDS = [
  "kind",
  "version",
  "project_root",
  "kickoff_response",
  "kickoff_artifacts_root",
  "spec_response",
  "spec_artifacts_root",
  "expected_sources",
  "expected_conflict_sources",
  "expected_kickoff_session_id",
  "expected_turn_session_id",
  "required_sections",
  "c1_zero_interview_score",
  "forbid_user_questions",
];
const M1_FIXTURE_FIELDS = [
  "kind",
  "version",
  "project_root",
  "kickoff_fixture",
  "transcript",
  "synthesis",
  "expected_spec",
  "required_sections",
  "c1_zero_interview_score",
  "forbid_user_questions",
];
const KICKOFF_PRODUCT_KINDS = SPEC_SYNTHESIS_SCHEMA.legacy_kickoff_product_kinds
  .split("|")
  .filter((kind) => kind !== "kg.kickoff_conflicts");
const TURN_LABEL = "kg.kickoff_turn";

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--check-fixture", "--fixture", "--artifacts"].includes(flag)) {
      fail(`无法识别参数 ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} 缺少值`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${flag} 只能提供一次`);
    out[key] = value;
    index += 1;
  }
  return out;
}

function resolveDeclared(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string list`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value;
}

function exactStringSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (actual.length !== left.length || JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs; actual=${left.join(", ")} expected=${right.join(", ")}`);
  }
}

function requirePath(value, label, type) {
  const file = resolveDeclared(value);
  if (!fs.existsSync(file)) throw new Error(`${label} does not exist: ${file}`);
  const stat = fs.statSync(file);
  if ((type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) {
    throw new Error(`${label} is not a ${type}: ${file}`);
  }
  if (type === "directory") return host.normalizeRoot(file).declared;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return host.canonicalPath(file);
}

function loadFixture(value) {
  const fixtureFile = requirePath(value, "fixture", "file");
  const { fixture } = loadSavedEvaluationFixture(fixtureFile, "kg.eval_spec_fixture", [1, 2]);
  if (fixture.kind !== "kg.eval_spec_fixture") throw new Error("fixture kind must be kg.eval_spec_fixture");
  if (fixture.version === 1) {
    exactFields(fixture, M1_FIXTURE_FIELDS, "M1 spec fixture");
    return { version: 1, fixture, fixtureFile };
  }
  exactFields(fixture, M2_FIXTURE_FIELDS, "M2 spec fixture");
  if (fixture.version !== 2) throw new Error("M2 spec fixture version must be 2");
  stringList(fixture.expected_sources, "expected_sources");
  stringList(fixture.expected_conflict_sources, "expected_conflict_sources", { allowEmpty: true });
  for (const field of ["expected_kickoff_session_id", "expected_turn_session_id", "required_sections"]) {
    if (typeof fixture[field] !== "string" || fixture[field].trim() === "") {
      throw new Error(`${field} is required`);
    }
  }
  if (fixture.c1_zero_interview_score !== 4 || fixture.forbid_user_questions !== true) {
    throw new Error("M2 spec fixture must require zero-interview C1 score 4");
  }
  exactStringSet(fixture.required_sections.split("|"), REQUIRED_SECTIONS, "required_sections");
  return {
    version: 2,
    fixture,
    fixtureFile,
    projectRoot: host.canonicalPath(requirePath(fixture.project_root, "project_root", "directory")),
    kickoffResponse: requirePath(fixture.kickoff_response, "kickoff_response", "file"),
    kickoffArtifactsRoot: requirePath(fixture.kickoff_artifacts_root, "kickoff_artifacts_root", "directory"),
    specResponse: requirePath(fixture.spec_response, "spec_response", "file"),
    specArtifactsRoot: requirePath(fixture.spec_artifacts_root, "spec_artifacts_root", "directory"),
  };
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function requireRunOk(run, label) {
  if (run.error) throw new Error(`${label} 启动失败：${run.error.message}`);
  if (run.status !== 0) throw new Error(`${label} 失败：${(run.stderr || run.stdout).trim()}`);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

function readMachine(file, label) {
  const content = fs.readFileSync(file, "utf8");
  try {
    return file.endsWith(".json") || content.trimStart().startsWith("{") ? JSON.parse(content) : parse(content);
  } catch (error) {
    throw new Error(`${label} cannot be parsed: ${error.message}`);
  }
}

function validateRunnerResponse(response, label) {
  const errors = [];
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return [`${label} must be an object`];
  }
  if (typeof response.session_id !== "string" || response.session_id.trim() === "") {
    errors.push(`${label}.session_id missing`);
  }
  for (const field of ["transcript", "file_reads", "citations", "products", "tool_events", "permission_denials"]) {
    if (!Array.isArray(response[field])) errors.push(`${label}.${field} must be an array`);
  }
  for (const [index, message] of (response.transcript ?? []).entries()) {
    if (
      !["system", "user", "assistant", "analysis", "tool"].includes(message?.role) ||
      typeof message?.content !== "string"
    ) {
      errors.push(`${label}.transcript[${index}] must contain role and content`);
    }
    if (message?.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      errors.push(`${label}.transcript[${index}].tool_calls must be an array`);
    }
  }
  for (const [index, read] of (response.file_reads ?? []).entries()) {
    if (typeof read?.path !== "string" || !Number.isInteger(read?.at_step)) {
      errors.push(`${label}.file_reads[${index}] must contain path and integer at_step`);
    }
  }
  for (const [index, citation] of (response.citations ?? []).entries()) {
    if (typeof citation?.path !== "string") errors.push(`${label}.citations[${index}] must contain path`);
  }
  for (const [index, product] of (response.products ?? []).entries()) {
    if (typeof product?.kind !== "string" || typeof product?.path !== "string") {
      errors.push(`${label}.products[${index}] must contain kind and path`);
    }
  }
  for (const [index, event] of (response.tool_events ?? []).entries()) {
    if (
      typeof event?.name !== "string" ||
      typeof event?.command !== "string" ||
      !Number.isInteger(event?.at_step) ||
      typeof event?.ok !== "boolean"
    ) {
      errors.push(`${label}.tool_events[${index}] must contain name, command, integer at_step, and ok`);
    }
  }
  for (const [index, denial] of (response.permission_denials ?? []).entries()) {
    if (
      typeof denial?.tool !== "string" ||
      !Number.isInteger(denial?.at_step) ||
      typeof denial?.detail !== "string"
    ) {
      errors.push(`${label}.permission_denials[${index}] must contain tool, integer at_step, and detail`);
    }
  }
  return errors;
}

function productOfKind(response, kind, { required = true } = {}) {
  const matches = (response.products ?? []).filter((product) => product?.kind === kind);
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) throw new Error(`runner must return exactly one ${kind} product`);
  return matches[0];
}

function resolveProduct(product, allowedRoot, label, { archived = false } = {}) {
  let productPath = product.path;
  if (archived && path.isAbsolute(product.path)) {
    const basename = path.basename(product.path);
    if (basename !== product.path.replaceAll("\\", "/").split("/").at(-1)) {
      throw new Error(`${label} product basename is not portable`);
    }
    productPath = basename;
  }
  return host.resolveProductPath(allowedRoot, productPath, { label: `${label} product` }).declared;
}

function sourceMetadata(file, sourcePath) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) {
    return {
      status: "unregistered",
      authority: sourcePath === "AGENTS.md" ? "project_instruction" : "reference_only",
    };
  }
  const { frontmatter } = protocol.splitFrontmatter(text);
  const status = frontmatter.status ?? frontmatter.lifecycle ?? "unregistered";
  const authority =
    frontmatter.authority ??
    (status === "accepted" ? "formal_decision" : status === "active" ? "project_knowledge" : "reference_only");
  return { status, authority };
}

function parseTurn(file, projectRoot) {
  const turn = readMachine(file, "kg.kickoff_turn");
  if (turn.kind !== "kg.kickoff_turn") {
    throw new Error("kg.kickoff_turn kind is invalid");
  }
  const turnVersion = productVersion.assertAcceptedVersion(turn, KICKOFF_TURN_SCHEMA, TURN_LABEL);
  const TURN_FIELDS = productVersion.fieldOrderForVersion(KICKOFF_TURN_SCHEMA, turnVersion, TURN_LABEL);
  const FINDING_FIELDS = productVersion.recordFieldOrderForVersion(
    KICKOFF_TURN_SCHEMA,
    turnVersion,
    "findings",
    TURN_LABEL,
  );
  exactFields(turn, TURN_FIELDS, "kg.kickoff_turn");
  if (typeof turn.session_id !== "string" || turn.session_id.trim() === "") {
    throw new Error("kg.kickoff_turn session_id is invalid");
  }
  if (!Array.isArray(turn.findings) || turn.findings.length === 0) {
    throw new Error("kg.kickoff_turn findings must be non-empty");
  }
  for (const [index, finding] of turn.findings.entries()) {
    exactFields(finding, FINDING_FIELDS, `kg.kickoff_turn.findings[${index}]`);
    const anchor = documentAnchor.validateStableDocumentReference({
      sourcePath: finding.source_path,
      line: finding.line,
      projectRoot,
    });
    const metadata = sourceMetadata(anchor.full, anchor.sourcePath);
    if (finding.status !== metadata.status || finding.authority !== metadata.authority) {
      throw new Error(`kg.kickoff_turn.findings[${index}] metadata mismatch`);
    }
  }
  return turn;
}

function scriptCommandHas(event, scriptPath, ...needles) {
  return isScriptInvocation(event, scriptPath) && needles.every((needle) => event.command.includes(needle));
}

function auditKickoffToolChain(response, turn, hasConflicts) {
  const failures = [];
  const events = response.tool_events ?? [];
  const indexEvent = events.find((event) => scriptCommandHas(event, "gather-context.mjs", "--phase", "index"));
  const deepEvent = events.find((event) => scriptCommandHas(event, "gather-context.mjs", "--phase", "deep"));
  const turnEvent = events.find((event) => scriptCommandHas(event, "record-turn.mjs", "--index"));
  const conflictEvent = events.find((event) => scriptCommandHas(event, "record-conflicts.mjs"));
  if (!indexEvent) failures.push("index gather-context.mjs tool event missing");
  if (!deepEvent) failures.push("deep gather-context.mjs tool event missing");
  if (!turnEvent) failures.push("record-turn.mjs --index tool event missing");
  if (
    indexEvent &&
    deepEvent &&
    turnEvent &&
    !(indexEvent.at_step < deepEvent.at_step && deepEvent.at_step < turnEvent.at_step)
  ) {
    failures.push("tool chain order must be index, deep, turn recorder");
  }
  if (hasConflicts && !conflictEvent) failures.push("record-conflicts.mjs tool event missing");
  if (hasConflicts && deepEvent && conflictEvent && !(deepEvent.at_step < conflictEvent.at_step)) {
    failures.push("conflict recorder must run after deep");
  }
  for (const finding of turn.findings) {
    if (deepEvent && !deepEvent.command.includes(finding.source_path)) {
      failures.push(`deep tool event does not name finding source: ${finding.source_path}`);
    }
  }
  return failures;
}

function auditIndexAndContext(index, context, turn, projectRoot) {
  const failures = [];
  if (
    index?.kind !== "kg.kickoff_context_index" ||
    !productVersion.acceptedVersions(KICKOFF_INDEX_SCHEMA, "kg.kickoff_context_index").includes(index?.version) ||
    !Array.isArray(index.entries) ||
    !Array.isArray(productVersion.indexEdgeList(index, KICKOFF_INDEX_SCHEMA))
  ) {
    return ["kickoff index shape is invalid"];
  }
  if (
    context?.kind !== "kg.kickoff_context" ||
    !productVersion.acceptedVersions(KICKOFF_DEEP_SCHEMA, "kg.kickoff_context").includes(context?.version) ||
    !Array.isArray(context.documents)
  ) {
    return ["kickoff context shape is invalid"];
  }
  const indexed = new Map(index.entries.map((entry) => [entry.path, entry]));
  const deep = new Map(context.documents.map((document) => [document.path, document]));
  for (const finding of turn.findings) {
    const entry = indexed.get(finding.source_path);
    const document = deep.get(finding.source_path);
    if (!entry) {
      failures.push(`finding source absent from index: ${finding.source_path}`);
      continue;
    }
    if (entry.status !== finding.status || entry.authority !== finding.authority) {
      failures.push(`index metadata mismatch for ${finding.source_path}`);
    }
    if (!document || typeof document.content !== "string") {
      failures.push(`finding source absent from deep context: ${finding.source_path}`);
      continue;
    }
    try {
      const source = host.resolveSafeRelative(projectRoot, finding.source_path);
      const bytes = Number.isInteger(document.bytes) ? document.bytes : Buffer.byteLength(document.content);
      if (fs.readFileSync(source.full).subarray(0, bytes).toString("utf8") !== document.content) {
        failures.push(`deep context bytes differ for ${finding.source_path}`);
      }
    } catch (error) {
      failures.push(`${finding.source_path}: ${error.message}`);
    }
  }
  return failures;
}

function auditKickoffEvidence(loaded, response) {
  const failures = validateRunnerResponse(response, "kickoff response");
  const warnings = (response.tool_events ?? [])
    .filter((event) => event?.ok === false)
    .map((event) => `kickoff tool failed at step ${event.at_step}: ${event.name} ${event.command}`);
  if (response.session_id !== loaded.fixture.expected_kickoff_session_id) {
    failures.push("kickoff runner session_id differs from fixture oracle");
  }
  failures.push(
    ...(response.permission_denials ?? []).map(
      (denial) => `permission denied for ${denial.tool} at step ${denial.at_step}: ${denial.detail}`,
    ),
  );
  let turn = null;
  let productKinds = [];
  try {
    productKinds = (response.products ?? []).map((product) => product.kind);
    const expectedKinds = [...KICKOFF_PRODUCT_KINDS];
    if (loaded.fixture.expected_conflict_sources.length > 0) expectedKinds.push("kg.kickoff_conflicts");
    exactStringSet(productKinds, expectedKinds, "kickoff product kind set");

    const turnFile = resolveProduct(
      productOfKind(response, "kg.kickoff_turn"),
      loaded.kickoffArtifactsRoot,
      "kg.kickoff_turn",
      { archived: true },
    );
    turn = parseTurn(turnFile, loaded.projectRoot);
    if (turn.session_id !== loaded.fixture.expected_turn_session_id) {
      failures.push("kg.kickoff_turn session_id differs from fixture oracle");
    }
    exactStringSet(
      turn.findings.map((finding) => finding.source_path),
      loaded.fixture.expected_sources,
      "kickoff source set",
    );
    const index = readMachine(
      resolveProduct(
        productOfKind(response, "kg.kickoff_context_index"),
        loaded.kickoffArtifactsRoot,
        "kg.kickoff_context_index",
        { archived: true },
      ),
      "kg.kickoff_context_index",
    );
    const context = readMachine(
      resolveProduct(
        productOfKind(response, "kg.kickoff_context"),
        loaded.kickoffArtifactsRoot,
        "kg.kickoff_context",
        { archived: true },
      ),
      "kg.kickoff_context",
    );
    failures.push(...auditIndexAndContext(index, context, turn, loaded.projectRoot));

    let conflicts = [];
    const conflictProduct = productOfKind(response, "kg.kickoff_conflicts", { required: false });
    if (conflictProduct) {
      const conflictRecord = readMachine(
        resolveProduct(
          conflictProduct,
          loaded.kickoffArtifactsRoot,
          "kg.kickoff_conflicts",
          { archived: true },
        ),
        "kg.kickoff_conflicts",
      );
      if (
        conflictRecord.kind !== "kg.kickoff_conflicts" ||
        conflictRecord.version !== 1 ||
        !Array.isArray(conflictRecord.conflicts)
      ) {
        throw new Error("kg.kickoff_conflicts shape is invalid");
      }
      conflicts = conflictRecord.conflicts;
    }
    exactStringSet(
      conflicts.map((conflict) => conflict.source_path),
      loaded.fixture.expected_conflict_sources,
      "kickoff conflict source set",
    );
    failures.push(...auditKickoffToolChain(response, turn, conflicts.length > 0));
  } catch (error) {
    failures.push(error.message);
  }
  return { failures, warnings, turn, productKinds };
}

function questionAudit(response) {
  const failures = [];
  for (const [index, message] of (response.transcript ?? []).entries()) {
    if (message?.role === "assistant" && /[?？]/.test(String(message.content ?? ""))) {
      failures.push(`assistant message ${index} contains a question mark`);
    }
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.name ?? call?.function?.name ?? "");
      if (isUserInteractionToolName(name)) {
        failures.push(`assistant message ${index} called ${name}`);
      }
    }
  }
  for (const [index, event] of (response.events ?? []).entries()) {
    if (isUserInteractionToolName(event?.type ?? event?.name ?? "")) {
      failures.push(`event ${index} is a follow-up question`);
    }
  }
  for (const [index, event] of (response.tool_events ?? []).entries()) {
    if (isUserInteractionToolName(event?.name ?? "")) {
      failures.push(`tool event ${index} is a follow-up question`);
    }
  }
  return failures;
}

function interactionToolAudit(response) {
  const failures = [];
  for (const [index, message] of (response.transcript ?? []).entries()) {
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.name ?? call?.function?.name ?? "");
      if (isUserInteractionToolName(name)) failures.push(`assistant message ${index} called ${name}`);
    }
  }
  for (const [index, event] of [...(response.events ?? []), ...(response.tool_events ?? [])].entries()) {
    if (isUserInteractionToolName(event?.type ?? event?.name ?? "")) {
      failures.push(`interaction event ${index} called ${event.type ?? event.name}`);
    }
  }
  return failures;
}

function subsetMatches(actual, expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return actual === expected;
  }
  return Object.entries(expected).every(([key, value]) => machineContract.canonicalJson(actual?.[key]) === machineContract.canonicalJson(value));
}

function evaluateSpecExpectation(expectation, synthesis) {
  if (expectation.assertion === "out_of_scope_item") {
    const match = synthesis.out_of_scope.find((item) => subsetMatches(item, expectation.expected));
    return { passed: Boolean(match), actualRef: match?.out_of_scope_id ?? "out_of_scope:none" };
  }
  if (expectation.assertion === "out_of_scope_absent") {
    const match = synthesis.out_of_scope.find((item) => item.statement === expectation.expected);
    return { passed: !match, actualRef: match?.out_of_scope_id ?? "out_of_scope:absent" };
  }
  if (expectation.assertion === "requirement_covered") {
    const requirement = synthesis.requirements.find((item) => item.statement === expectation.expected);
    const acceptance = requirement
      ? synthesis.acceptance_criteria.find((item) => item.requirement_ids.includes(requirement.requirement_id))
      : null;
    return {
      passed: Boolean(requirement && acceptance),
      actualRef: requirement && acceptance ? `${requirement.requirement_id}->${acceptance.acceptance_id}` : "trace:none",
    };
  }
  if (expectation.assertion === "constraint_anchor_present") {
    const actual = synthesis.constraints.map((item) => item.source_path);
    return {
      passed: actual.includes(expectation.expected),
      actualRef: actual.includes(expectation.expected) ? expectation.expected : actual.join("|"),
    };
  }
  return { passed: false, actualRef: `unsupported:${expectation.assertion}` };
}

export function scoreSpecMachineProducts({
  fixtureRoot,
  synthesisFile,
  specFile,
  packetFile,
  response,
  projectRoot,
}) {
  const loaded = loadSplitEvaluationFixture({
    scenarioFile: path.join(fixtureRoot, "scenario.json"),
    oracleFile: path.join(fixtureRoot, "oracle.json"),
  });
  if (loaded.scenario.evaluator !== "spec") throw new Error("split fixture evaluator must be spec");
  const synthesis = readJson(synthesisFile, "validated synthesis");
  const synthesisErrors = protocol.validateRecord(synthesis, SPEC_SYNTHESIS_SCHEMA);
  const packetBytes = fs.readFileSync(packetFile);
  if (synthesis.packet_sha256 !== machineContract.sha256Bytes(packetBytes)) {
    synthesisErrors.push("packet hash binding differs from packet bytes");
  }
  const specCheck = runNode([PRODUCE, "--check", specFile, "--project-root", projectRoot]);
  const interactionFailures = interactionToolAudit(response);
  const productKinds = (response.products ?? []).map((item) => item.kind);
  const packetOnlyFailures = [];
  if (!hasPacketReadEvidence(response, packetFile)) packetOnlyFailures.push("packet read tool event missing");
  if (productKinds.length !== 1 || productKinds[0] !== "kg.spec_synthesis") {
    packetOnlyFailures.push("spec response must register only kg.spec_synthesis");
  }
  if (productKinds.some((kind) => kind.startsWith("kg.kickoff_"))) {
    packetOnlyFailures.push("spec response registered a kickoff product");
  }

  const expectationResults = scoreableOracle(loaded).map((expectation) => ({
    expectation,
    result: evaluateSpecExpectation(expectation, synthesis),
  }));
  const hardAssertions = expectationResults.map(({ expectation, result }) => ({
    assertion_id: expectation.expectation_id,
    passed: result.passed,
    expected_ref: expectation.derivation,
    actual_ref: result.actualRef,
    message: expectation.assertion,
  }));
  hardAssertions.push({
    assertion_id: "c1-packet-only",
    passed: interactionFailures.length === 0 && packetOnlyFailures.length === 0,
    expected_ref: "protocol/evaluation-rubric.schema.yaml#C1",
    actual_ref: `interaction=${interactionFailures.length};packet=${packetOnlyFailures.length}`,
    message: "Synthesis uses no interaction tool and registers only the packet-bound synthesis product.",
  });
  hardAssertions.push({
    assertion_id: "structured-product-and-render",
    passed: synthesisErrors.length === 0 && specCheck.status === 0,
    expected_ref: "protocol/spec-synthesis.schema.yaml#version=3",
    actual_ref: `schema=${synthesisErrors.length};checker=${specCheck.status}`,
    message: "Structured synthesis and rendered spec pass their protocol checkers.",
  });
  const c2Expectations = expectationResults.filter(({ expectation }) => expectation.criterion_id === "C2");
  const c3Expectations = expectationResults.filter(({ expectation }) => expectation.criterion_id === "C3");
  const structurePass = synthesisErrors.length === 0 && specCheck.status === 0;
  const c2Pass = structurePass && c2Expectations.every(({ result }) => result.passed);
  const c3Pass = structurePass && c3Expectations.every(({ result }) => result.passed);
  const criterionChecks = {
    C1: {
      value: interactionFailures.length === 0 && packetOnlyFailures.length === 0 ? 4 : 0,
      passed_checks: interactionFailures.length === 0 && packetOnlyFailures.length === 0 ? ["packet_only", "zero_interaction"] : [],
      failed_checks: [...interactionFailures, ...packetOnlyFailures],
    },
    C2: {
      value: c2Pass ? 3 : structurePass ? 2 : 0,
      passed_checks: c2Expectations.filter(({ result }) => result.passed).map(({ expectation }) => expectation.expectation_id),
      failed_checks: c2Expectations.filter(({ result }) => !result.passed).map(({ expectation }) => expectation.expectation_id),
    },
    C3: {
      value: c3Pass ? 3 : structurePass ? 2 : 0,
      passed_checks: c3Expectations.filter(({ result }) => result.passed).map(({ expectation }) => expectation.expectation_id),
      failed_checks: c3Expectations.filter(({ result }) => !result.passed).map(({ expectation }) => expectation.expectation_id),
    },
  };
  return buildEvaluationScore({
    evaluator: "spec",
    fixtureId: loaded.scenario.fixture_id,
    oracleSha256: loaded.oracleSha256,
    productHashes: [
      { kind: "kg.spec_synthesis_packet", path: path.basename(packetFile), sha256: machineContract.sha256File(packetFile) },
      { kind: "kg.spec_synthesis", path: path.basename(synthesisFile), sha256: machineContract.sha256File(synthesisFile) },
      { kind: "kg.task_spec", path: path.basename(specFile), sha256: machineContract.sha256File(specFile) },
    ],
    criterionChecks,
    hardAssertions,
    advisory: loaded.advisoryExpectations.map((item) => ({
      advisory_id: item.expectation_id,
      message: item.assertion,
      source_refs: item.derivation ? [item.derivation] : [],
    })),
    evaluatedAt: synthesis.created_at,
  });
}

function citationAudit(response, projectRoot, expectedSources) {
  const failures = [];
  const warnings = [];
  const cited = [];
  for (const citation of response.citations ?? []) {
    try {
      if (typeof citation.path !== "string" || path.isAbsolute(citation.path)) {
        throw new Error("citation path must be project-relative");
      }
      const resolved = host.resolveSafeRelative(projectRoot, citation.path);
      if (!fs.statSync(resolved.full).isFile()) throw new Error("citation is not a file");
      if (citation.line !== undefined) {
        if (!Number.isInteger(citation.line) || citation.line < 1) throw new Error("citation line is invalid");
        const lineCount = fs.readFileSync(resolved.full, "utf8").split(/\r?\n/).length;
        if (citation.line > lineCount) throw new Error("citation line exceeds file");
      }
      cited.push(resolved.relative);
    } catch (error) {
      failures.push(`invalid citation ${citation.path}: ${error.message}`);
    }
  }
  const uniqueCited = [...new Set(cited)].sort();
  const expected = [...new Set(expectedSources)].sort();
  const missing = expected.filter((sourcePath) => !uniqueCited.includes(sourcePath));
  if (missing.length > 0) {
    failures.push(`spec citations omit expected finding sources: ${missing.join(", ")}`);
  }
  const extras = uniqueCited.filter((sourcePath) => !expected.includes(sourcePath));
  if (extras.length > 0) {
    warnings.push(`spec citations include additional sources: ${extras.join(", ")}`);
  }
  return { failures, warnings };
}

function hasPacketReadEvidence(response, packetFile) {
  return hasProductReadEvidence(response, packetFile, (value) => host.canonicalPath(value));
}

function fileSnapshot(root, { excludeSpecs = false } = {}) {
  const records = [];
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (excludeSpecs && (rel === "docs/specs" || rel.startsWith("docs/specs/"))) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) records.push([rel, "link", fs.readlinkSync(full)]);
      else if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        records.push([rel, "file", crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
      }
    }
  }
  walk(root, "");
  return records;
}

function packetRecord(packet, kind) {
  const product = packet.intermediate_products.find((item) => item.kind === kind);
  if (!product) return null;
  return product.path.endsWith(".json") || product.content.trimStart().startsWith("{")
    ? JSON.parse(product.content)
    : parse(product.content);
}

function legacyReplayDraft(packet, legacy) {
  const turn = packetRecord(packet, "kg.kickoff_turn");
  const conflicts = packetRecord(packet, "kg.kickoff_conflicts")?.conflicts ?? [];
  const findingId = (finding) => `KF-${machineContract.sha256CanonicalJson({
    source_path: finding.source_path,
    line: finding.line,
  }).slice(-12).toUpperCase()}`;
  const conflictId = (conflict) => `KC-${machineContract.sha256CanonicalJson({
    source_path: conflict.source_path,
    line: conflict.line,
  }).slice(-12).toUpperCase()}`;
  return {
    task: { title: legacy.task.title },
    context: legacy.context.map((statement) => ({ statement, source_refs: ["transcript#message=0"] })),
    requirements: legacy.requirements.map((statement) => ({ statement, source_refs: ["transcript#message=0"] })),
    constraints: legacy.constraints.map((item) => {
      const finding = turn.findings.find((candidate) => `${candidate.source_path}#L${candidate.line}` === item.source_path);
      return { ...item, finding_id: finding ? findingId(finding) : "KF-000000000000" };
    }),
    references: legacy.references.map((referencePath) => ({ path: referencePath, purpose: "Implementation reference" })),
    out_of_scope: legacy.out_of_scope.map((item) => {
      const conflict = conflicts.find((candidate) => candidate.source_path === item.conflict_source_path);
      return {
        statement: item.statement,
        source_class: conflict ? "conflict" : "explicit_no",
        source_ref: conflict
          ? `kg.kickoff_conflicts#conflict=${conflictId(conflict)}`
          : "transcript#message=0",
      };
    }),
    acceptance_criteria: legacy.acceptance_criteria.map((item) => {
      const match = /^GIVEN (.+) WHEN (.+) THEN (.+)$/.exec(item);
      return {
        given: match?.[1] ?? "",
        when: match?.[2] ?? "",
        then: match?.[3] ?? "",
        requirement_ids: legacy.requirements.map((unused, index) => `REQ-${String(index + 1).padStart(3, "0")}`),
      };
    }),
    open_questions: legacy.open_questions.map((question) => ({ question, source_refs: ["transcript#message=0"] })),
    session_history: legacy.session_history.map((item) => ({
      session_id: item.session_id,
      turn_ids: [item.turn_session_id],
      product_kinds: item.product_kinds,
    })),
  };
}

function archiveSynthesis(loaded, kickoffResponseFile, specResponse, synthesisFile, projectRoot, tempRoot) {
  const packet = path.join(tempRoot, "spec-packet.json");
  requireRunOk(
    runNode([
      PRODUCE,
      "--prepare",
      "--project-root",
      projectRoot,
      "--transcript",
      kickoffResponseFile,
      "--kickoff-artifacts",
      loaded.kickoffArtifactsRoot,
      "--output",
      packet,
    ]),
    "prepare",
  );
  const beforeSpecs = fs.existsSync(path.join(projectRoot, "docs", "specs"))
    ? fs.readdirSync(path.join(projectRoot, "docs", "specs")).filter((name) => /^TASK-/.test(name))
    : [];
  if (beforeSpecs.length !== 0) {
    throw new Error("session ran archive; the evaluator owns the archive step");
  }
  const before = fileSnapshot(projectRoot, { excludeSpecs: true });
  let archiveInput = synthesisFile;
  const submitted = readJson(synthesisFile, "spec synthesis");
  if (submitted.version === 2) {
    const replayDraft = path.join(tempRoot, "legacy-replay-draft.json");
    const validated = path.join(tempRoot, "validated-spec-synthesis.json");
    writeJson(replayDraft, legacyReplayDraft(readJson(packet, "spec packet"), submitted));
    requireRunOk(
      runNode([
        PRODUCE,
        "--validate-synthesis",
        "--project-root",
        projectRoot,
        "--packet",
        packet,
        "--synthesis",
        replayDraft,
        "--output",
        validated,
        "--now",
        FIXED_NOW,
      ]),
      "validate synthesis",
    );
    archiveInput = validated;
  } else if (
    submitted.version === SPEC_SYNTHESIS_SCHEMA.product_version &&
    !(specResponse.tool_events ?? []).some(
      (event) => isScriptInvocation(event, "produce-spec.mjs") && event.command.includes("--validate-synthesis"),
    )
  ) {
    throw new Error("version 3 synthesis lacks a successful --validate-synthesis tool event");
  }
  const archived = runNode([
    PRODUCE,
    "--archive",
    "--project-root",
    projectRoot,
    "--packet",
    packet,
    "--synthesis",
    archiveInput,
  ]);
  requireRunOk(archived, "archive");
  let archiveResult;
  try {
    archiveResult = JSON.parse(archived.stdout);
  } catch (error) {
    throw new Error(`archive stdout is not JSON: ${error.message}`);
  }
  if (
    archiveResult.kind !== "kg.spec_archive_result" ||
    archiveResult.version !== 1 ||
    archiveResult.task_id !== "TASK-20260731-001" ||
    archiveResult.created_at !== FIXED_NOW ||
    archiveResult.status !== "draft" ||
    archiveResult.path !== "docs/specs/TASK-20260731-001.md"
  ) {
    throw new Error("archive result envelope is invalid");
  }
  const specFile = path.join(projectRoot, ...archiveResult.path.split("/"));
  requireRunOk(runNode([PRODUCE, "--check", specFile, "--project-root", projectRoot]), "check");
  if (JSON.stringify(fileSnapshot(projectRoot, { excludeSpecs: true })) !== JSON.stringify(before)) {
    throw new Error("archive changed project files outside docs/specs");
  }
  const specs = fs.readdirSync(path.join(projectRoot, "docs", "specs")).filter((name) => /^TASK-/.test(name));
  if (JSON.stringify(specs) !== JSON.stringify(["TASK-20260731-001.md"])) {
    throw new Error("archive lifecycle created an unexpected task spec set");
  }
  const text = fs.readFileSync(specFile, "utf8");
  const { frontmatter, body } = protocol.splitFrontmatter(text);
  if (
    frontmatter.task_id !== archiveResult.task_id ||
    frontmatter.created_at !== archiveResult.created_at ||
    frontmatter.status !== "draft"
  ) {
    throw new Error("archived frontmatter does not match the script-owned envelope");
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!body.includes(`## ${section}\n`)) throw new Error(`archived spec is missing section ${section}`);
  }
  if (!body.includes(loaded.fixture.expected_kickoff_session_id)) {
    throw new Error("Session History omits the kickoff runner session");
  }
  if (!body.includes(loaded.fixture.expected_turn_session_id)) {
    throw new Error("Session History omits the structured kickoff turn session");
  }
  for (const kind of (specResponse.products ?? []).map((product) => product.kind)) {
    if (kind !== "kg.spec_synthesis") throw new Error(`unexpected spec product kind ${kind}`);
  }
  return { packet, specFile, archiveResult };
}

function evaluateSpecResponse(loaded, kickoffResponseFile, response, specArtifactsRoot, projectRoot, tempRoot) {
  const schemaFailures = validateRunnerResponse(response, "spec response");
  const questionFailures = questionAudit(response);
  const scoreInteractionFailures = interactionToolAudit(response);
  const executionFailures = (response.permission_denials ?? []).map(
    (denial) => `permission denied for ${denial.tool} at step ${denial.at_step}: ${denial.detail}`,
  );
  const warnings = (response.tool_events ?? [])
    .filter((event) => event?.ok === false)
    .map((event) => `spec tool failed at step ${event.at_step}: ${event.name} ${event.command}`);
  const citationResult = citationAudit(response, projectRoot, loaded.fixture.expected_sources);
  warnings.push(...citationResult.warnings);
  const productFailures = [];
  let synthesisFile = null;
  let archive = null;
  try {
    synthesisFile = resolveProduct(
      productOfKind(response, "kg.spec_synthesis"),
      specArtifactsRoot,
      "kg.spec_synthesis",
    );
    if ((response.products ?? []).length !== 1) {
      throw new Error("spec runner must return exactly one product");
    }
    const packet = path.join(tempRoot, "spec-packet.json");
    if (!hasPacketReadEvidence(response, packet)) {
      throw new Error("spec runner lacks a successful packet read tool event");
    }
    archive = archiveSynthesis(
      loaded,
      kickoffResponseFile,
      response,
      synthesisFile,
      projectRoot,
      tempRoot,
    );
  } catch (error) {
    productFailures.push(error.message);
  }
  return {
    pass: false,
    session_id: response.session_id ?? null,
    c1_zero_interview_score: questionFailures.length === 0 ? 4 : 0,
    schema_pass: schemaFailures.length === 0,
    source_set_pass: citationResult.failures.length === 0 && productFailures.length === 0,
    session_history_pass: productFailures.length === 0,
    lifecycle_pass: productFailures.length === 0,
    no_followup_pass: questionFailures.length === 0,
    runner_execution_pass: executionFailures.length === 0,
    score_interaction_failures: scoreInteractionFailures,
    failures: {
      runner_schema: schemaFailures,
      runner_execution: executionFailures,
      questions: questionFailures,
      citations: citationResult.failures,
      products: productFailures,
    },
    warnings,
    archive,
  };
}

function finishResult(result) {
  result.score = calculateRubricScore({
    evaluator: "spec",
    criterionValues: {
      C1: result.score_interaction_failures.length === 0 ? 4 : 0,
      C2: result.lifecycle_pass && result.session_history_pass ? 3 : 0,
      C3: result.source_set_pass ? 3 : 0,
    },
    hardAssertions: [
      result.schema_pass,
      result.source_set_pass,
      result.session_history_pass,
      result.lifecycle_pass,
      result.runner_execution_pass,
    ].map((passed) => ({ passed })),
  });
  result.pass =
    result.c1_zero_interview_score === 4 &&
    result.schema_pass &&
    result.source_set_pass &&
    result.session_history_pass &&
    result.lifecycle_pass &&
    result.no_followup_pass &&
    result.runner_execution_pass &&
    result.score.pass;
  return result;
}

function runM2FixtureCheck(loaded) {
  const kickoffResponse = readJson(loaded.kickoffResponse, "kickoff response");
  const kickoffAudit = auditKickoffEvidence(loaded, kickoffResponse);
  if (kickoffAudit.failures.length) {
    fail(`spec 夹具 kickoff 证据判定失败：${kickoffAudit.failures.join("; ")}`);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kg-spec-fixture-"));
  try {
    const projectRoot = path.join(temp, "project");
    fs.cpSync(loaded.projectRoot, projectRoot, { recursive: true });
    const specResponse = readJson(loaded.specResponse, "spec response");
    const result = finishResult(
      evaluateSpecResponse(
        loaded,
        loaded.kickoffResponse,
        specResponse,
        loaded.specArtifactsRoot,
        projectRoot,
        temp,
      ),
    );
    result.warnings = [...kickoffAudit.warnings, ...result.warnings];
    if (!result.pass) fail(`spec 夹具判定失败：${JSON.stringify(result)}`);
    for (const warning of result.warnings) console.error(`kg: warning: ${warning}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("kg: spec v2 夹具检查通过，C9 结构、零访谈、source 集合、session 与 archive 生命周期全部命中");
}

function normalizeGeneratedCreatedAt(text) {
  const matches = text.match(/^created_at: .+$/gm) ?? [];
  if (matches.length !== 1) throw new Error("generated spec must contain exactly one created_at field");
  return text.replace(/^created_at: .+$/m, "created_at: <generated>");
}

function runM1FixtureCheck(loaded) {
  const fixture = loaded.fixture;
  const projectRoot = requirePath(fixture.project_root, "project_root", "directory");
  const transcript = requirePath(fixture.transcript, "transcript", "file");
  const synthesis = requirePath(fixture.synthesis, "synthesis", "file");
  const expected = requirePath(fixture.expected_spec, "expected_spec", "file");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kg-spec-m1-fixture-"));
  try {
    const packet = path.join(temp, "packet.json");
    const spec = path.join(temp, "spec.md");
    requireRunOk(
      runNode([PRODUCE, "--prepare", "--project-root", projectRoot, "--transcript", transcript, "--output", packet]),
      "prepare",
    );
    requireRunOk(
      runNode([
        PRODUCE,
        "--finalize",
        "--project-root",
        projectRoot,
        "--packet",
        packet,
        "--synthesis",
        synthesis,
        "--output",
        spec,
        "--now",
        FIXED_NOW,
      ]),
      "finalize",
    );
    requireRunOk(runNode([PRODUCE, "--check", spec, "--project-root", projectRoot]), "check");
    if (normalizeGeneratedCreatedAt(fs.readFileSync(spec, "utf8")) !== fs.readFileSync(expected, "utf8")) {
      throw new Error("M1 spec structure differs from expected/task-spec.md");
    }
  } catch (error) {
    fail(`M1 spec 夹具判定失败：${error.message}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("kg: M1 spec 夹具兼容检查通过");
}

function loadRunner() {
  const runner = process.env.KG_EVAL_RUNNER;
  if (!runner) fail("缺少 KG_EVAL_RUNNER；真实 C10 门禁需要可执行 runner 的绝对路径");
  if (!path.isAbsolute(runner)) fail("KG_EVAL_RUNNER 必须是绝对路径");
  try {
    fs.accessSync(runner, fs.constants.X_OK);
  } catch {
    fail(`KG_EVAL_RUNNER 不可执行：${runner}`);
  }
  return runner;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runReal(loaded, artifactsValue) {
  if (loaded.version !== 2) fail("真实 C10 只接受 M2 spec fixture version 2");
  if (!artifactsValue) fail("真实评测缺少 --artifacts");
  const kickoffResponse = readJson(loaded.kickoffResponse, "kickoff response");
  const kickoffAudit = auditKickoffEvidence(loaded, kickoffResponse);
  if (kickoffAudit.failures.length) {
    fail(`C9 输入证据无效：${kickoffAudit.failures.join("; ")}`);
  }
  const runner = loadRunner();
  const artifacts = path.resolve(artifactsValue);
  if (host.hasPathSegment(artifacts, ".kg")) fail("artifacts 目录不得位于 .kg 内");
  if (fs.existsSync(artifacts) && fs.readdirSync(artifacts).length > 0) {
    fail(`artifacts 目录必须为空：${artifacts}`);
  }
  fs.mkdirSync(artifacts, { recursive: true });
  const projectRoot = path.join(artifacts, "workspace", "project");
  const sessionArtifacts = path.join(artifacts, "session");
  fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
  fs.mkdirSync(sessionArtifacts, { recursive: true });
  fs.cpSync(loaded.projectRoot, projectRoot, { recursive: true });
  const packet = path.join(sessionArtifacts, "spec-packet.json");
  const prepare = runNode([
    PRODUCE,
    "--prepare",
    "--project-root",
    projectRoot,
    "--transcript",
    loaded.kickoffResponse,
    "--kickoff-artifacts",
    loaded.kickoffArtifactsRoot,
    "--output",
    packet,
  ]);
  try {
    requireRunOk(prepare, "prepare");
  } catch (error) {
    fail(error.message);
  }
  const request = {
    protocol_version: "1.1",
    skill: "kg-spec",
    prompt:
      "Read the read-only spec-packet.json in artifacts_dir and produce zero-interview semantic synthesis. " +
      "Do not ask the user any question and do not call request-user-input. " +
      "Write a strict JSON version 3 synthesis draft with no kind, version, ID, timestamp, status, or hash fields. " +
      "Requirements, acceptance criteria, Out of Scope, Open Questions, and Session History must use the structured protocol records. " +
      `Run ${PRODUCE} --validate-synthesis with the supplied packet, pass --now ${FIXED_NOW}, and write the canonical result to artifacts_dir/spec-synthesis.json. ` +
      "This session must only produce the validated synthesis JSON. Do not run --archive; " +
      "the evaluator owns the archive step and will run it with a fixed clock. " +
      "Preserve packet conflict IDs, transcript message pointers, DMZ decision anchors, constraint source metadata, " +
      "finding IDs, and the structured kickoff session record. Constraint source_path values include stable #L line anchors. " +
      "Register exactly one kg.spec_synthesis product.",
    project_root: projectRoot,
    artifacts_dir: sessionArtifacts,
    config: {
      packet_path: packet,
      validator_path: PRODUCE,
      draft_path: path.join(sessionArtifacts, "spec-synthesis-draft.json"),
      synthesis_path: path.join(sessionArtifacts, "spec-synthesis.json"),
      zero_interview_required: true,
    },
  };
  writeJson(path.join(artifacts, "request.json"), request);
  fs.writeFileSync(path.join(artifacts, "actual-prompt.txt"), `${request.prompt}\n`);
  const run = spawnSync(runner, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(artifacts, "runner-stdout.txt"), run.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, "runner-stderr.txt"), run.stderr ?? "");
  if (run.error) fail(`runner 启动失败：${run.error.message}`);
  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch {
    fail(`runner stdout 不是 JSON；stderr：${run.stderr.trim()}`);
  }
  const result = finishResult(
    evaluateSpecResponse(
      loaded,
      loaded.kickoffResponse,
      response,
      sessionArtifacts,
      projectRoot,
      sessionArtifacts,
    ),
  );
  result.warnings = [...kickoffAudit.warnings, ...result.warnings];
  if (run.status !== 0) {
    result.runner_execution_pass = false;
    result.failures.runner_execution.push(
      `runner exited ${run.status}: ${response.error ?? run.stderr.trim() ?? "unknown error"}`,
    );
    result.pass = false;
  }
  writeJson(path.join(artifacts, "runner-output.json"), response);
  writeJson(path.join(artifacts, "result.json"), result);
  if (!result.pass) fail(`真实 kg-spec 门禁失败，详见 ${path.join(artifacts, "result.json")}`);
  console.log(`kg: 真实 kg-spec 门禁通过，证据已保存到 ${artifacts}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let loaded;
  try {
    loaded = loadFixture(args.check_fixture ?? args.fixture);
  } catch (error) {
    fail(`spec fixture 无效：${error.message}`);
  }
  if (args.check_fixture) {
    if (args.fixture || args.artifacts) fail("--check-fixture 不能与真实评测参数混用");
    if (loaded.version === 1) runM1FixtureCheck(loaded);
    else runM2FixtureCheck(loaded);
    return;
  }
  if (!args.fixture || !args.artifacts) {
    fail("用法：eval-spec.mjs --fixture <fixture.yaml> --artifacts <empty-dir>");
  }
  runReal(loaded, args.artifacts);
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
