#!/usr/bin/env node

// Provider-neutral G-DOC1 evaluator. The agent sees only the scenario,
// installed skill, evidence packet, transcript, and disposable project.
// Oracle expectations are loaded and applied only after the runner exits.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSplitEvaluationFixture } from "./lib/eval-fixture.mjs";
import { countScriptInvocations, scriptInvocationEvents } from "./lib/eval-tool-audit.mjs";
import * as host from "./lib/host.mjs";
import * as kyaml from "./lib/kyaml.mjs";
import * as machineContract from "./lib/machine-contract.mjs";
import * as protocol from "./lib/protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_SOURCE = path.join(ROOT, "skills", "kg-docs");
const DOCS_VALIDATE = path.join(ROOT, "skills", "kg-compile", "scripts", "validate-project-documents.mjs");

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--check-fixture", "--fixture", "--artifacts"].includes(flag)) fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  if (out.check_fixture) {
    if (out.fixture || out.artifacts) fail("--check-fixture cannot be combined with real-session options");
    return out;
  }
  if (!out.fixture || !out.artifacts) fail("usage: eval-docs.mjs --fixture <family-dir> --artifacts <empty-dir>");
  return out;
}

function loadFixture(value) {
  const fixtureRoot = path.resolve(value);
  const loaded = loadSplitEvaluationFixture({
    scenarioFile: path.join(fixtureRoot, "scenario.json"),
    oracleFile: path.join(fixtureRoot, "oracle.json"),
  });
  if (loaded.scenario.evaluator !== "docs") throw new Error("G-DOC1 fixture evaluator must be docs");
  return loaded;
}

function loadRunner() {
  const runner = process.env.KG_EVAL_RUNNER;
  if (!runner || !path.isAbsolute(runner)) throw new Error("KG_EVAL_RUNNER must be an absolute executable path");
  fs.accessSync(runner, fs.constants.X_OK);
  return runner;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readMachine(file, label) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return path.extname(file).toLowerCase() === ".json" || text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : kyaml.parse(text);
  } catch (error) {
    throw new Error(`${label} is not parseable: ${error.message}`);
  }
}

function validateRunnerResponse(response) {
  const errors = [];
  if (response === null || typeof response !== "object" || Array.isArray(response)) return ["runner response must be an object"];
  if (typeof response.session_id !== "string" || response.session_id.trim() === "") errors.push("session_id missing");
  for (const field of ["transcript", "file_reads", "citations", "products", "tool_events", "permission_denials"]) {
    if (!Array.isArray(response[field])) errors.push(`${field} must be an array`);
  }
  for (const [index, product] of (response.products ?? []).entries()) {
    if (typeof product?.kind !== "string" || typeof product?.path !== "string") {
      errors.push(`products[${index}] must contain kind and path`);
    }
  }
  for (const [index, event] of (response.tool_events ?? []).entries()) {
    if (typeof event?.name !== "string" || typeof event?.command !== "string" ||
        (!Number.isInteger(event?.at_step) && typeof event?.at_step !== "string") || typeof event?.ok !== "boolean") {
      errors.push(`tool_events[${index}] is invalid`);
    }
  }
  return errors;
}

function productsOfKind(response, kind, count) {
  const products = (response.products ?? []).filter((product) => product.kind === kind);
  if (products.length !== count) throw new Error(`runner must return exactly ${count} ${kind} product(s)`);
  return products;
}

function resolveProduct(product, roots, label) {
  const failures = [];
  for (const root of roots) {
    try {
      return host.resolveProductPath(root, product.path, { label }).declared;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`${label} is outside allowed product roots: ${failures.join("; ")}`);
}

function oracleValues(value, output = []) {
  if (Array.isArray(value)) for (const item of value) oracleValues(item, output);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) oracleValues(item, output);
  else if (typeof value === "string" && value.length >= 8) output.push(value);
  return [...new Set(output)];
}

function oracleIsolationAudit(prompt, loaded) {
  const visibleSource = loaded.scenario.task;
  const leaked = oracleValues(loaded.oracle)
    .filter((value) => !visibleSource.includes(value) && prompt.includes(value));
  return { pass: leaked.length === 0, leaked_values: leaked };
}

function markdownText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function parseDecisionTemplate(file) {
  const text = fs.readFileSync(file, "utf8");
  const sections = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->\r?\n## ([^\r\n]+)$/gm)]
    .map((match) => ({ key: match[1], heading: match[2] }));
  const roles = new Map(
    [...text.matchAll(/^<!-- kg:adr-role ([a-z][a-z0-9_]*) -->\r?\n<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)]
      .map((match) => [match[1], match[2]]),
  );
  if (sections.length === 0 || !roles.has("alternatives") || !roles.has("consequences")) {
    throw new Error("decision template lacks section or ADR role markers");
  }
  return { sections, roles };
}

function independentRender(request, template, targetPath, requestSha256) {
  const frontmatter = {
    kind: "kg.project_document",
    title: request.title,
    doc_type: request.doc_type,
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: request.source_refs,
  };
  const marker = {
    kind: "kg.scaffold_document",
    version: 1,
    request_sha256: requestSha256,
    doc_type: request.doc_type,
    target_path: targetPath,
    candidate_ref: request.candidate_ref,
    source_refs: request.source_refs,
  };
  const byKey = new Map(request.sections.map((section) => [section.key, section.content]));
  const lines = [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${markdownText(request.title)}`,
    "",
    `<!-- kg:evidence ${Buffer.from(JSON.stringify(marker), "utf8").toString("base64url")} -->`,
    "",
  ];
  for (const section of template.sections) {
    const content = byKey.get(section.key);
    lines.push(`<!-- kg:section ${section.key} -->`, `## ${section.heading}`, "");
    if (template.roles.get("alternatives") === section.key) {
      for (const item of content) lines.push(`- **${markdownText(item.option)}**: ${markdownText(item.tradeoff)}`);
    } else {
      for (const item of content) lines.push(`- ${markdownText(item)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function hardExpectation(loaded, expectationId) {
  const item = loaded.hardExpectations.find((expectation) => expectation.expectation_id === expectationId);
  if (!item) throw new Error(`oracle lacks hard expectation ${expectationId}`);
  return item.expected;
}

function verifyProducts({ response, projectRoot, sessionRoot, installedSkill, packetFile, transcriptFile, loaded }) {
  const failures = [];
  try {
    const packet = readMachine(packetFile, "ADR evidence packet");
    const packetErrors = protocol.validateRecord(packet, protocol.loadAdrEvidencePacketSchema());
    if (packetErrors.length > 0) throw new Error(`ADR evidence packet is invalid: ${packetErrors.join("; ")}`);
    const assessments = productsOfKind(response, "kg.adr_assessment", packet.candidates.length)
      .map((product) => {
        const file = resolveProduct(product, [sessionRoot], "ADR assessment product");
        const value = readMachine(file, "ADR assessment");
        const errors = protocol.validateRecord(value, protocol.loadAdrAssessmentSchema());
        if (errors.length > 0) throw new Error(`ADR assessment is invalid: ${errors.join("; ")}`);
        if (value.evidence_packet_sha256 !== machineContract.sha256File(packetFile)) {
          throw new Error(`${value.candidate_ref} assessment packet hash differs`);
        }
        return { file, value };
      });
    const byCandidate = new Map(assessments.map((item) => [item.value.candidate_ref, item]));
    if (byCandidate.size !== packet.candidates.length || packet.candidates.some((item) => !byCandidate.has(item.candidate_ref))) {
      throw new Error("assessment products do not cover the evidence packet exactly");
    }
    const eligible = hardExpectation(loaded, "eligible-candidate");
    const transcript = readMachine(transcriptFile, "human approval transcript");
    const approvalIndex = transcript.approvals?.find(
      (item) => item.action === `draft:${eligible}` && transcript.transcript?.[item.message_index]?.role === "user",
    )?.message_index;
    const scaffoldApproval = transcript.approvals?.some(
      (item) => item.action === "scaffold:decision" && item.message_index === approvalIndex,
    );
    if (!Number.isInteger(approvalIndex) || !scaffoldApproval) {
      throw new Error("eligible candidate lacks bound human draft and scaffold approvals");
    }
    const nearMisses = new Map([
      [hardExpectation(loaded, "reversible-near-miss"), "hard_to_reverse"],
      [hardExpectation(loaded, "context-near-miss"), "context_not_in_code"],
      [hardExpectation(loaded, "tradeoff-near-miss"), "genuine_tradeoff"],
    ]);
    const eligibleAssessment = byCandidate.get(eligible);
    if (!eligibleAssessment || eligibleAssessment.value.eligible_for_draft !== true ||
        eligibleAssessment.value.criteria.some((criterion) => criterion.conclusion !== true)) {
      throw new Error("oracle eligible candidate did not pass all ADR criteria");
    }
    for (const [candidate, failedCriterion] of nearMisses) {
      const assessment = byCandidate.get(candidate)?.value;
      if (!assessment || assessment.eligible_for_draft !== false) throw new Error(`${candidate} near miss became eligible`);
      for (const criterion of assessment.criteria) {
        if (criterion.conclusion !== (criterion.criterion_id !== failedCriterion)) {
          throw new Error(`${candidate} must fail exactly ${failedCriterion}`);
        }
      }
    }

    const requestProduct = productsOfKind(response, "kg.docs_scaffold_request", 1)[0];
    const requestFile = resolveProduct(requestProduct, [sessionRoot], "scaffold request product");
    const request = readMachine(requestFile, "scaffold request");
    const requestErrors = protocol.validateRecord(request, protocol.loadDocsScaffoldRequestSchema());
    if (requestErrors.length > 0) throw new Error(`scaffold request is invalid: ${requestErrors.join("; ")}`);
    if (request.doc_type !== "decision" || request.candidate_ref !== eligible) {
      throw new Error("scaffold request does not target the eligible decision candidate");
    }
    const requestedAssessment = path.isAbsolute(request.adr_assessment)
      ? path.resolve(request.adr_assessment)
      : path.resolve(projectRoot, ...request.adr_assessment.replaceAll("\\", "/").split("/"));
    if (host.canonicalPath(requestedAssessment) !== host.canonicalPath(eligibleAssessment.file)) {
      throw new Error("scaffold request does not bind the eligible assessment product");
    }
    const expectedRefs = [...new Set(eligibleAssessment.value.criteria.flatMap((criterion) => criterion.evidence_refs))].sort();
    if (JSON.stringify([...request.source_refs].sort()) !== JSON.stringify(expectedRefs)) {
      throw new Error("decision source_refs do not equal the eligible assessment evidence set");
    }

    const resultProduct = productsOfKind(response, "kg.docs_scaffold_result", 1)[0];
    const resultFile = resolveProduct(resultProduct, [sessionRoot], "scaffold result product");
    const result = readMachine(resultFile, "scaffold result");
    const resultErrors = protocol.validateRecord(result, protocol.loadDocsScaffoldResultSchema());
    if (resultErrors.length > 0) throw new Error(`scaffold result is invalid: ${resultErrors.join("; ")}`);
    const expectedSlug = eligible.replace(/^CAND-/, "").toLowerCase();
    const expectedTarget = `docs/decisions/0001-${expectedSlug}.md`;
    if (result.mode !== "created" || result.doc_type !== "decision" || result.target_path !== expectedTarget) {
      throw new Error(`scaffold result target must be ${expectedTarget}`);
    }
    if (result.approval_message_index !== approvalIndex) throw new Error("scaffold result approval pointer differs from transcript");
    if (host.canonicalPath(result.assessment_ref) !== host.canonicalPath(eligibleAssessment.file)) {
      throw new Error("scaffold result does not bind the eligible assessment product");
    }
    const documentProduct = productsOfKind(response, "kg.project_document", hardExpectation(loaded, "one-decision-draft"))[0];
    const documentFile = resolveProduct(documentProduct, [projectRoot], "decision document product");
    if (host.canonicalPath(documentFile) !== host.canonicalPath(path.join(projectRoot, ...expectedTarget.split("/")))) {
      throw new Error("decision document product path differs from scaffold result");
    }
    const decisionFiles = fs.existsSync(path.join(projectRoot, "docs", "decisions"))
      ? fs.readdirSync(path.join(projectRoot, "docs", "decisions"), { withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    if (decisionFiles.length !== 1) throw new Error("near-miss candidates produced decision files");
    const template = parseDecisionTemplate(path.join(installedSkill, "assets", "templates", "decision.md"));
    const expectedBytes = independentRender(request, template, expectedTarget, machineContract.sha256File(requestFile));
    const actualBytes = fs.readFileSync(documentFile, "utf8");
    if (actualBytes !== expectedBytes) throw new Error("decision bytes differ from independent template rendering");
    if (result.document_sha256 !== machineContract.sha256Bytes(Buffer.from(actualBytes))) {
      throw new Error("scaffold result document hash differs from target bytes");
    }
    const validate = spawnSync(process.execPath, [DOCS_VALIDATE, documentFile], {
      cwd: projectRoot,
      env: { ...process.env, KG_ROOT: projectRoot },
      encoding: "utf8",
    });
    if (validate.error || validate.status !== 0) {
      throw new Error(`decision validator failed: ${(validate.stderr || validate.error?.message || "").trim()}`);
    }
  } catch (error) {
    failures.push(error.message);
  }
  return failures;
}

function toolAudit(response) {
  const events = response.tool_events ?? [];
  const assessments = scriptInvocationEvents(events, "assess-adr.mjs");
  const scaffolds = scriptInvocationEvents(events, "scaffold.mjs");
  const failures = [];
  if (countScriptInvocations(events, "assess-adr.mjs") !== 4) failures.push("tool chain must call assess-adr.mjs exactly four times");
  if (countScriptInvocations(events, "scaffold.mjs") !== 1) failures.push("tool chain must call scaffold.mjs exactly once");
  if (assessments.length === 4 && scaffolds.length === 1 && events.indexOf(scaffolds[0]) < events.indexOf(assessments.at(-1))) {
    failures.push("scaffold must run after all four ADR assessments");
  }
  return failures;
}

function saveEvidence(artifacts, response, result) {
  writeJson(path.join(artifacts, "runner-output.json"), response);
  for (const field of ["transcript", "file_reads", "citations", "products", "tool_events", "permission_denials"]) {
    writeJson(path.join(artifacts, `${field.replaceAll("_", "-")}.json`), response[field] ?? []);
  }
  writeJson(path.join(artifacts, "result.json"), result);
}

function responsibilityFinding({ run, response, result }) {
  const beforeFirstTool = (response?.tool_events ?? []).length === 0;
  const surface = run.status !== 0 && beforeFirstTool ? "runner_adapter" : "agent";
  const terminalMessage = response?.transcript?.at(-1)?.content ?? null;
  return {
    kind: "kg.evaluation_responsibility_finding",
    version: 1,
    gate: "G-DOC1",
    responsibility_surface: surface,
    before_first_tool_call: beforeFirstTool,
    runner_exit_code: run.status,
    session_id: response?.session_id ?? null,
    terminal_message: terminalMessage,
    oracle_modified: false,
    failures: result.failures,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.check_fixture) {
      const loaded = loadFixture(args.check_fixture);
      console.log(`kg: G-DOC1 fixture valid; ${loaded.hardExpectations.length} hard expectations`);
      return;
    }
    const loaded = loadFixture(args.fixture);
    const runner = loadRunner();
    const artifacts = path.resolve(args.artifacts);
    if (host.hasPathSegment(artifacts, ".kg")) throw new Error("artifacts must not enter .kg");
    if (fs.existsSync(artifacts) && fs.readdirSync(artifacts).length > 0) throw new Error("artifacts directory must be empty");
    fs.mkdirSync(artifacts, { recursive: true });
    const projectRoot = path.join(artifacts, "workspace", "project");
    const sessionRoot = path.join(artifacts, "session");
    fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
    fs.cpSync(path.join(loaded.fixtureRoot, "host"), projectRoot, { recursive: true });
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.cpSync(path.join(loaded.fixtureRoot, "evidence"), path.join(sessionRoot, "evidence"), { recursive: true });
    const installedSkill = path.join(projectRoot, ".agents", "skills", "kg-docs");
    fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
    fs.cpSync(DOCS_SOURCE, installedSkill, { recursive: true });
    const packetFile = path.join(sessionRoot, "evidence", "adr-evidence-packet.json");
    const transcriptFile = path.join(sessionRoot, "evidence", "transcript.json");
    const prompt =
      `In project_root, perform the kg-docs ADR assessment task: ${loaded.scenario.task} ` +
      `Read ${path.join(installedSkill, "SKILL.md")}, ${packetFile}, ${transcriptFile}, and the evidence paths named by the packet. ` +
      `For every candidate, write strict agent input JSON under ${path.join(sessionRoot, "inputs")} and invoke ` +
      `${path.join(installedSkill, "scripts", "assess-adr.mjs")} with the packet, transcript, input, and a unique output under ${path.join(sessionRoot, "assessments")}. ` +
      "Use every protocol criterion exactly once. A criterion conclusion must follow the cited source bytes. " +
      `After all assessments, scaffold exactly the eligible approved candidate by writing one strict request to ${path.join(sessionRoot, "scaffold-request.json")} and invoking ` +
      `${path.join(installedSkill, "scripts", "scaffold.mjs")} once with a result at ${path.join(sessionRoot, "scaffold-result.json")}. ` +
      "Derive a lowercase slug from the eligible candidate reference. Populate every template section, include at least two real options and non-empty consequences, and use the assessment evidence refs as source_refs. " +
      "Do not scaffold any ineligible candidate. Return products for each kg.adr_assessment, the kg.docs_scaffold_request, the kg.docs_scaffold_result, and the one kg.project_document. " +
      "Return complete transcript, file_reads, citations, products, tool_events, and permission_denials.";
    const request = {
      protocol_version: "1.1",
      skill: "kg-docs",
      prompt,
      project_root: projectRoot,
      artifacts_dir: sessionRoot,
      config: { workflow: "adr_scaffold" },
    };
    writeJson(path.join(artifacts, "request.json"), request);
    fs.writeFileSync(path.join(artifacts, "actual-prompt.txt"), `${prompt}\n`);
    const timeoutSeconds = Number.parseInt(process.env.KG_EVAL_TIMEOUT ?? "900", 10);
    const run = spawnSync(runner, [], {
      input: JSON.stringify(request),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: (Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 900) * 1000,
    });
    fs.writeFileSync(path.join(artifacts, "runner-stdout.txt"), run.stdout ?? "");
    fs.writeFileSync(path.join(artifacts, "runner-stderr.txt"), run.stderr ?? "");
    let response;
    try {
      response = JSON.parse(run.stdout);
    } catch {
      response = { session_id: null, transcript: [], file_reads: [], citations: [], products: [], tool_events: [], permission_denials: [] };
    }
    const runnerPromptFile = path.join(sessionRoot, "runner-prompt.txt");
    const auditedPrompt = fs.existsSync(runnerPromptFile)
      ? `${prompt}\n${fs.readFileSync(runnerPromptFile, "utf8")}`
      : prompt;
    const promptAudit = oracleIsolationAudit(auditedPrompt, loaded);
    writeJson(path.join(artifacts, "oracle-isolation-audit.json"), promptAudit);
    const result = {
      pass: false,
      session_id: response.session_id ?? null,
      failures: {
        runner_exit: [],
        runner_schema: validateRunnerResponse(response),
        permissions: (response.permission_denials ?? []).map((item) => `${item.tool}: ${item.detail}`),
        tools: toolAudit(response),
        oracle_isolation: promptAudit.pass ? [] : [`oracle leaked: ${promptAudit.leaked_values.join(", ")}`],
        deterministic_validation: [],
      },
    };
    if (run.error) result.failures.runner_exit.push(run.error.message);
    if (run.status !== 0) result.failures.runner_exit.push(`runner exited ${run.status}: ${response.error ?? (run.stderr ?? "").trim()}`);
    result.failures.deterministic_validation.push(...verifyProducts({
      response,
      projectRoot,
      sessionRoot,
      installedSkill,
      packetFile,
      transcriptFile,
      loaded,
    }));
    result.pass = Object.values(result.failures).every((items) => items.length === 0);
    saveEvidence(artifacts, response, result);
    if (!result.pass) {
      writeJson(path.join(artifacts, "responsibility-finding.json"), responsibilityFinding({ run, response, result }));
      throw new Error(`G-DOC1 failed; see ${path.join(artifacts, "result.json")}`);
    }
    console.log(`kg: G-DOC1 passed; evidence saved at ${artifacts}`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
