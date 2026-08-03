// Provider-neutral G-B bootstrap evaluator. The evaluator creates a
// disposable host, invokes one external agent runner, verifies the recorded
// tool chain, and rechecks all machine products deterministically.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as host from "./lib/host.mjs";
import * as protocol from "./lib/protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP_SOURCE = path.join(ROOT, "skills", "kg-docs");
const DOCS_VALIDATE = path.join(ROOT, "skills", "kg-compile", "scripts", "validate-project-documents.mjs");
const FIXTURE_FIELDS = ["kind", "version", "project_source", "task", "oracle"];
const ORACLE_FIELDS = [
  "kind",
  "version",
  "expected_document_count",
  "required_evidence_source_paths",
  "prompt_isolation_values",
  "expected_proposal_target_paths",
];
const PROPOSAL_MANIFEST_FIELDS = [
  "kind",
  "version",
  "proposal_id",
  "doc_type",
  "target_path",
  "target_sha256",
  "candidate_path",
  "candidate_sha256",
  "inventory_sha256",
  "source_refs",
  "status",
];

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--fixture", "--artifacts"].includes(flag)) fail(`无法识别参数 ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} 缺少值`);
    out[flag.slice(2)] = value;
    index += 1;
  }
  if (!out.fixture || !out.artifacts) fail("用法：eval-bootstrap.mjs --fixture <fixture.json> --artifacts <empty-dir>");
  return out;
}

function resolveDeclared(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

function rejectUnknown(record, allowed, label) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function loadFixture(value) {
  const file = resolveDeclared(value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`夹具不存在：${file}`);
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`夹具 JSON 无效：${error.message}`);
  }
  try {
    rejectUnknown(fixture, FIXTURE_FIELDS, "bootstrap fixture");
  } catch (error) {
    fail(error.message);
  }
  if (fixture.kind !== "kg.eval_bootstrap_fixture" || ![1, 2, 3].includes(fixture.version)) {
    fail("bootstrap fixture 的 kind/version 无效");
  }
  if (typeof fixture.task !== "string" || fixture.task.trim() === "") fail("bootstrap fixture 缺少 task");
  if (typeof fixture.project_source !== "string" || fixture.project_source.trim() === "") {
    fail("bootstrap fixture 缺少 project_source");
  }
  const projectSource = resolveDeclared(fixture.project_source);
  if (!fs.existsSync(projectSource) || !fs.statSync(projectSource).isDirectory()) {
    fail(`bootstrap fixture 项目不存在：${projectSource}`);
  }
  if (host.hasPathSegment(projectSource, ".kg")) fail("bootstrap fixture 项目不得位于 .kg 内");
  let oracle = null;
  let oracleFile = null;
  if ([2, 3].includes(fixture.version)) {
    if (typeof fixture.oracle !== "string" || fixture.oracle.trim() === "") fail(`version ${fixture.version} bootstrap fixture 缺少 evaluator oracle`);
    oracleFile = resolveDeclared(fixture.oracle);
    if (!fs.existsSync(oracleFile) || !fs.statSync(oracleFile).isFile()) fail(`bootstrap oracle 不存在：${oracleFile}`);
    try {
      oracle = JSON.parse(fs.readFileSync(oracleFile, "utf8"));
      rejectUnknown(oracle, ORACLE_FIELDS, "bootstrap oracle");
    } catch (error) {
      fail(`bootstrap oracle 无效：${error.message}`);
    }
    if (
      oracle.kind !== "kg.eval_bootstrap_oracle" ||
      oracle.version !== 1 ||
      !Number.isInteger(oracle.expected_document_count) ||
      oracle.expected_document_count <= 0 ||
      !Array.isArray(oracle.required_evidence_source_paths) ||
      !oracle.required_evidence_source_paths.every((item) => typeof item === "string" && item.trim() !== "") ||
      !Array.isArray(oracle.prompt_isolation_values) ||
      !oracle.prompt_isolation_values.every((item) => typeof item === "string" && item.trim() !== "") ||
      (oracle.expected_proposal_target_paths !== undefined &&
        (!Array.isArray(oracle.expected_proposal_target_paths) ||
          !oracle.expected_proposal_target_paths.every((item) => typeof item === "string" && item.trim() !== "")))
    ) {
      fail("bootstrap oracle 字段无效");
    }
    const proposalTargets = oracle.expected_proposal_target_paths ?? [];
    if (fixture.version === 2 && proposalTargets.length !== 0) fail("version 2 bootstrap oracle 不接受 proposal target");
    if (fixture.version === 3 && proposalTargets.length === 0) fail("version 3 bootstrap oracle 必须声明 proposal target");
  } else if (fixture.oracle !== undefined) {
    fail("version 1 bootstrap fixture 不接受 oracle");
  }
  return { fixture, file, projectSource, oracle, oracleFile };
}

function loadRunner() {
  const runner = process.env.KG_EVAL_RUNNER;
  if (!runner) fail("缺少 KG_EVAL_RUNNER；真实 G-B 门禁需要可执行 runner 的绝对路径");
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

export function validateRunnerResponse(response) {
  const errors = [];
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    return ["runner response must be an object"];
  }
  if (typeof response.session_id !== "string" || response.session_id.trim() === "") errors.push("session_id missing");
  for (const field of ["transcript", "file_reads", "citations", "products"]) {
    if (!Array.isArray(response[field])) errors.push(`${field} must be an array`);
  }
  if (!Array.isArray(response.tool_events)) errors.push("tool_events must be an array for G-B");
  if (!Array.isArray(response.permission_denials)) errors.push("permission_denials must be an array");
  for (const [index, event] of (response.tool_events ?? []).entries()) {
    if (
      typeof event?.name !== "string" ||
      typeof event?.command !== "string" ||
      (!Number.isInteger(event?.at_step) && typeof event?.at_step !== "string") ||
      typeof event?.ok !== "boolean"
    ) {
      errors.push(`tool_events[${index}] must contain name, command, at_step, and ok`);
    }
  }
  for (const [index, denial] of (response.permission_denials ?? []).entries()) {
    if (
      typeof denial?.tool !== "string" ||
      (!Number.isInteger(denial?.at_step) && typeof denial?.at_step !== "string") ||
      typeof denial?.detail !== "string"
    ) {
      errors.push(`permission_denials[${index}] must contain tool, at_step, and detail`);
    }
  }
  for (const [index, product] of (response.products ?? []).entries()) {
    if (typeof product?.kind !== "string" || typeof product?.path !== "string") {
      errors.push(`products[${index}] must contain kind and path`);
    }
  }
  for (const [index, message] of (response.transcript ?? []).entries()) {
    if (!["system", "user", "assistant", "tool"].includes(message?.role) || typeof message?.content !== "string") {
      errors.push(`transcript[${index}] must contain role and content`);
    }
    if (message?.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
      errors.push(`transcript[${index}].tool_calls must be an array`);
    }
  }
  for (const [index, read] of (response.file_reads ?? []).entries()) {
    if (typeof read?.path !== "string" || (!Number.isInteger(read?.at_step) && typeof read?.at_step !== "string")) {
      errors.push(`file_reads[${index}] must contain path and at_step`);
    }
  }
  for (const [index, citation] of (response.citations ?? []).entries()) {
    if (typeof citation?.path !== "string") errors.push(`citations[${index}] must contain path`);
    if (citation?.line !== undefined && (!Number.isInteger(citation.line) || citation.line < 1)) {
      errors.push(`citations[${index}].line must be a positive integer`);
    }
  }
  return errors;
}

export function runnerEnvelopeConformanceProfile(response) {
  const arrays = ["transcript", "file_reads", "citations", "products", "tool_events", "permission_denials"];
  const itemFields = Object.fromEntries(arrays.map((field) => [
    field,
    [...new Set((response[field] ?? []).flatMap((item) => Object.keys(item ?? {})))].sort(),
  ]));
  const pathForm = (value) => path.isAbsolute(value) ? "absolute" : "relative";
  return {
    top_level_fields: ["session_id", ...arrays].filter((field) => Object.hasOwn(response, field)).sort(),
    item_fields: itemFields,
    path_forms: {
      file_reads: [...new Set((response.file_reads ?? []).map((item) => pathForm(item.path)))].sort(),
      citations: [...new Set((response.citations ?? []).map((item) => pathForm(item.path)))].sort(),
      products: [...new Set((response.products ?? []).map((item) => pathForm(item.path)))].sort(),
    },
  };
}

function requireProduct(response, kind) {
  const matches = (response.products ?? []).filter((product) => product?.kind === kind);
  if (matches.length !== 1) throw new Error(`runner must return exactly one ${kind} product`);
  return matches[0];
}

function requireProducts(response, kind, count) {
  const matches = (response.products ?? []).filter((product) => product?.kind === kind);
  if (matches.length !== count) throw new Error(`runner must return exactly ${count} ${kind} product(s)`);
  return matches;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inventoryDigest(inventory) {
  return crypto.createHash("sha256").update(canonicalJson(inventory)).digest("hex");
}

function loadTaxonomyContract() {
  const taxonomy = protocol.loadDocumentTaxonomy();
  const templates = new Map();
  for (const docType of taxonomy.core_types ?? []) {
    const record = taxonomy.documents?.[docType];
    if (!record?.template_path || !record?.create_target_pattern) throw new Error(`taxonomy route missing for ${docType}`);
    const templateFile = path.join(ROOT, record.template_path);
    if (!fs.existsSync(templateFile) || !fs.statSync(templateFile).isFile()) throw new Error(`template missing for ${docType}`);
    const text = fs.readFileSync(templateFile, "utf8");
    const sections = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->\r?\n## ([^\r\n]+)$/gm)].map(
      (match) => ({ key: match[1], heading: match[2] }),
    );
    const placeholders = [...text.matchAll(/\{\{findings:([a-z][a-z0-9_]*)\}\}/g)].map((match) => match[1]);
    if (sections.length === 0 || canonicalJson(placeholders) !== canonicalJson(sections.map((section) => section.key))) {
      throw new Error(`template section contract is invalid for ${docType}`);
    }
    templates.set(docType, { ...record, sections });
  }
  return { taxonomy, templates };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetFilenamePattern(template, slug) {
  let value = escapeRegex(path.posix.basename(template.create_target_pattern));
  value = value.replace("\\{sequence\\}", "[0-9]{4}");
  value = value.replace("\\{slug\\}", escapeRegex(slug ?? ""));
  return new RegExp(`^${value}$`);
}

function expectedV2Targets(projectRoot, plan, taxonomyState) {
  if (!Array.isArray(plan.documents)) throw new Error("version 2 plan documents are missing");
  const byType = new Map(plan.documents.map((document) => [document.doc_type, document]));
  if (byType.size !== taxonomyState.taxonomy.core_types.length) throw new Error("version 2 plan does not cover taxonomy core_types");
  const targets = new Map();
  for (const docType of taxonomyState.taxonomy.core_types) {
    const document = byType.get(docType);
    if (!document) throw new Error(`version 2 plan is missing ${docType}`);
    const template = taxonomyState.templates.get(docType);
    let targetPath;
    if (document.mode === "proposal") {
      if (typeof document.target_path !== "string" || document.target_path.trim() === "") {
        throw new Error(`proposal target is missing for ${docType}`);
      }
      targetPath = document.target_path;
      host.resolveSafeRelative(projectRoot, targetPath);
    } else {
      targetPath = template.create_target_pattern.replace("{slug}", document.slug ?? "");
    }
    if (document.mode !== "proposal" && targetPath.includes("{sequence}")) {
      const directory = path.posix.dirname(targetPath);
      const resolvedDirectory = host.resolveSafeRelative(projectRoot, directory);
      const matcher = targetFilenamePattern(template, document.slug);
      const names = fs.readdirSync(resolvedDirectory.full, { withFileTypes: true })
        .filter((entry) => entry.isFile() && matcher.test(entry.name))
        .map((entry) => entry.name);
      if (names.length !== 1) throw new Error(`expected one sequence target for ${docType}, found ${names.length}`);
      targetPath = path.posix.join(directory, names[0]);
    }
    targets.set(docType, { document, targetPath });
  }
  return targets;
}

function decodeEvidenceMarkers(text) {
  return [...text.matchAll(/^<!-- kg:evidence ([A-Za-z0-9_-]+) -->$/gm)].map((match) =>
    JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
}

function normalizedFindingMarkers(document) {
  return document.sections.flatMap((section) => section.findings.map((finding) => {
    const out = {
      section: section.key,
      classification: finding.classification,
      statement: String(finding.statement).trim().replace(/\s+/g, " "),
      sources: finding.sources,
    };
    if (finding.classification === "inference") out.confidence = finding.confidence;
    if (finding.classification === "unknown") {
      out.missing_evidence = String(finding.missing_evidence).trim().replace(/\s+/g, " ");
    }
    return out;
  }));
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function relativeProductPath(projectRoot, product, label) {
  const resolved = host.resolveProductPath(projectRoot, product.path, { label });
  return path.relative(projectRoot, resolved.declared).replaceAll("\\", "/");
}

function proposalCandidates({ response, projectRoot, routes, inventory, targetBaselines }) {
  const proposalRoutes = [...routes.values()].filter(({ document }) => document.mode === "proposal");
  const manifestProducts = requireProducts(response, "kg.docs_bootstrap_proposal", proposalRoutes.length);
  const candidateProducts = requireProducts(response, "kg.project_document_candidate", proposalRoutes.length);
  const declaredCandidates = new Set(candidateProducts.map((product) => relativeProductPath(projectRoot, product, "proposal candidate")));
  const byTarget = new Map();
  const inventorySha256 = inventoryDigest(inventory);
  for (const product of manifestProducts) {
    const manifestRelative = relativeProductPath(projectRoot, product, "proposal manifest");
    const manifestFile = path.join(projectRoot, manifestRelative);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    rejectUnknown(manifest, PROPOSAL_MANIFEST_FIELDS, "proposal manifest");
    const route = [...routes.values()].find(({ targetPath }) => targetPath === manifest.target_path);
    if (!route || route.document.mode !== "proposal") throw new Error(`unexpected proposal target: ${manifest.target_path}`);
    if (byTarget.has(manifest.target_path)) throw new Error(`duplicate proposal target: ${manifest.target_path}`);
    const target = path.join(projectRoot, manifest.target_path);
    const targetSha256 = fileSha256(target);
    if (targetBaselines.get(manifest.target_path) !== targetSha256) {
      throw new Error(`proposal changed target bytes: ${manifest.target_path}`);
    }
    const candidate = host.resolveProductPath(projectRoot, manifest.candidate_path, { label: "proposal candidate" });
    const candidateRelative = path.relative(projectRoot, candidate.declared).replaceAll("\\", "/");
    if (!declaredCandidates.has(candidateRelative)) throw new Error(`proposal candidate product missing: ${candidateRelative}`);
    const candidateSha256 = fileSha256(candidate.declared);
    const contentId = crypto.createHash("sha256").update(canonicalJson({
      target_path: manifest.target_path,
      target_sha256: targetSha256,
      candidate_sha256: candidateSha256,
      inventory_sha256: inventorySha256,
    })).digest("hex");
    const proposalId = `bootstrap-${contentId}`;
    const bundlePath = `docs/proposals/${proposalId}`;
    if (manifestRelative !== `${bundlePath}/manifest.json` || candidateRelative !== `${bundlePath}/candidate.md`) {
      throw new Error(`proposal bundle path is not content addressed: ${manifest.target_path}`);
    }
    const candidateText = fs.readFileSync(candidate.declared, "utf8");
    const { frontmatter } = protocol.splitFrontmatter(candidateText);
    const expectedManifest = {
      kind: "kg.docs_bootstrap_proposal",
      version: 1,
      proposal_id: proposalId,
      doc_type: route.document.doc_type,
      target_path: manifest.target_path,
      target_sha256: targetSha256,
      candidate_path: candidateRelative,
      candidate_sha256: candidateSha256,
      inventory_sha256: inventorySha256,
      source_refs: frontmatter.source_refs ?? [],
      status: "proposed",
    };
    if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
      throw new Error(`proposal manifest differs from target and candidate content: ${manifest.target_path}`);
    }
    byTarget.set(manifest.target_path, candidateRelative);
  }
  if (byTarget.size !== proposalRoutes.length) throw new Error("proposal products do not cover every proposal plan item");
  return byTarget;
}

function validateV2Documents({ response, projectRoot, plan, inventory, oracle, targetBaselines }) {
  const failures = [];
  try {
    const taxonomyState = loadTaxonomyContract();
    if (oracle.expected_document_count !== taxonomyState.taxonomy.core_types.length) {
      throw new Error("oracle document count differs from taxonomy core_types");
    }
    const targets = expectedV2Targets(projectRoot, plan, taxonomyState);
    const expectedProposalTargets = [...(oracle.expected_proposal_target_paths ?? [])].sort();
    const actualProposalTargets = [...targets.values()]
      .filter(({ document }) => document.mode === "proposal")
      .map(({ targetPath }) => targetPath)
      .sort();
    if (canonicalJson(actualProposalTargets) !== canonicalJson(expectedProposalTargets)) {
      throw new Error("proposal plan targets differ from evaluator oracle");
    }
    const proposalByTarget = proposalCandidates({ response, projectRoot, routes: targets, inventory, targetBaselines });
    const createRoutes = [...targets.values()].filter(({ document }) => document.mode === "create");
    const products = requireProducts(response, "kg.project_document", createRoutes.length);
    const productPaths = new Set();
    for (const product of products) {
      productPaths.add(relativeProductPath(projectRoot, product, "project document"));
    }
    if (canonicalJson([...productPaths].sort()) !== canonicalJson(createRoutes.map(({ targetPath }) => targetPath).sort())) {
      throw new Error("project document products differ from taxonomy-derived targets");
    }
    const digest = inventoryDigest(inventory);
    const allSourcePaths = new Set();
    const validatedPaths = [];
    for (const [docType, route] of targets) {
      const { document: rawDocument, targetPath } = route;
      const documentPath = rawDocument.mode === "proposal" ? proposalByTarget.get(targetPath) : targetPath;
      const text = fs.readFileSync(path.join(projectRoot, documentPath), "utf8");
      const { frontmatter } = protocol.splitFrontmatter(text);
      if (frontmatter.doc_type !== docType || frontmatter.status !== "draft") {
        throw new Error(`frontmatter identity is invalid for ${targetPath}`);
      }
      const template = taxonomyState.templates.get(docType);
      const sectionKeys = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)].map((match) => match[1]);
      if (canonicalJson(sectionKeys) !== canonicalJson(template.sections.map((section) => section.key))) {
        throw new Error(`rendered section keys differ from template for ${targetPath}`);
      }
      const markers = decodeEvidenceMarkers(text);
      const documentMarker = markers.shift();
      const expectedDocumentMarker = {
        kind: "kg.bootstrap_document",
        version: 2,
        inventory_sha256: digest,
        doc_type: docType,
        target_path: targetPath,
        coverage_limitations: rawDocument.coverage_limitations.map((item) => String(item).trim().replace(/\s+/g, " ")),
      };
      if (canonicalJson(documentMarker) !== canonicalJson(expectedDocumentMarker)) {
        throw new Error(`document evidence marker differs from canonical plan for ${targetPath}`);
      }
      const expectedFindings = normalizedFindingMarkers(rawDocument);
      if (canonicalJson(markers) !== canonicalJson(expectedFindings)) {
        throw new Error(`finding evidence markers differ from canonical plan for ${targetPath}`);
      }
      for (const marker of markers) for (const source of marker.sources) allSourcePaths.add(source.path);
      validatedPaths.push(documentPath);
    }
    for (const required of oracle.required_evidence_source_paths) {
      if (!allSourcePaths.has(required)) throw new Error(`required evaluator-side evidence source was not used: ${required}`);
    }
    if (!Array.isArray(response.citations) || response.citations.length === 0) throw new Error("runner citations are empty");
    for (const citation of response.citations) host.resolveSafeRelative(projectRoot, citation.path);
    if (fs.existsSync(path.join(projectRoot, "should-not-run.executed"))) throw new Error("bootstrap executed host code");
    return { failures, targetPaths: validatedPaths };
  } catch (error) {
    failures.push(error.message);
    return { failures, targetPaths: [] };
  }
}

function oracleIsolationAudit(prompt, loaded) {
  if (loaded.fixture.version === 1) return { pass: true, checked_values: 0, leaked_values: [] };
  const leakedValues = loaded.oracle.prompt_isolation_values.filter((value) => prompt.includes(value));
  if (prompt.includes(loaded.fixture.oracle) || prompt.includes(path.basename(loaded.oracleFile))) {
    leakedValues.push("<oracle-path>");
  }
  if (!host.isOutside(loaded.projectSource, loaded.oracleFile)) leakedValues.push("<oracle-inside-project-source>");
  return {
    pass: leakedValues.length === 0,
    checked_values: loaded.oracle.prompt_isolation_values.length,
    leaked_values: [...new Set(leakedValues)],
    prompt_sha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    oracle_sha256: crypto.createHash("sha256").update(fs.readFileSync(loaded.oracleFile)).digest("hex"),
  };
}

export function resolveArtifactProduct(product, artifactRoot, label) {
  return host.resolveProductPath(artifactRoot, product.path, { label: `${label} product` }).declared;
}

function isShellToolName(name) {
  const normalized = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const shellTokens = new Set(["bash", "sh", "zsh", "fish", "shell", "powershell", "pwsh", "terminal", "cmd", "exec"]);
  return normalized
    .split("_")
    .filter(Boolean)
    .some((token) => shellTokens.has(token));
}

function toolChainAudit(response, inventoryFile, planFile) {
  const events = response.tool_events ?? [];
  const inventoryIndex = events.findIndex(
    (event) =>
      event?.ok === true &&
      event.command.includes("inventory.mjs") &&
      event.command.includes("--root") &&
      event.command.includes("--output"),
  );
  const bootstrapIndex = events.findIndex(
    (event) =>
      event?.ok === true &&
      event.command.includes("bootstrap.mjs") &&
      event.command.includes("--project-root") &&
      event.command.includes("--inventory") &&
      event.command.includes("--plan"),
  );
  const planIndex = events.findIndex(
    (event, index) =>
      event?.ok === true &&
      index > inventoryIndex &&
      (bootstrapIndex < 0 || index < bootstrapIndex) &&
      !isShellToolName(event.name) &&
      event.command.includes(path.basename(planFile)),
  );
  const failures = [];
  if (inventoryIndex < 0) failures.push("inventory.mjs tool event missing");
  if (planIndex < 0) failures.push("JSON plan submission tool event missing");
  if (bootstrapIndex < 0) failures.push("bootstrap.mjs tool event missing");
  if (
    inventoryIndex >= 0 &&
    planIndex >= 0 &&
    bootstrapIndex >= 0 &&
    !(inventoryIndex < planIndex && planIndex < bootstrapIndex)
  ) {
    failures.push("tool chain order must be inventory, JSON plan submission, bootstrap");
  }
  if (bootstrapIndex >= 0) {
    const command = events[bootstrapIndex].command;
    if (!command.includes(path.basename(inventoryFile))) failures.push("bootstrap command did not consume the inventory product");
    if (!command.includes(path.basename(planFile))) failures.push("bootstrap command did not consume the JSON plan product");
  }
  return failures;
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function requireRunOk(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}: ${(result.stderr || result.error?.message || "").trim()}`);
  }
}

function auditProjectReads(response, projectRoot) {
  const failures = [];
  for (const read of response.file_reads ?? []) {
    try {
      host.resolveSafeRelative(projectRoot, read.path);
    } catch (error) {
      failures.push(`invalid project read ${read.path}: ${error.message}`);
    }
  }
  return failures;
}

function saveEvidence(artifacts, response, result) {
  writeJson(path.join(artifacts, "runner-output.json"), response);
  writeJson(path.join(artifacts, "transcript.json"), response.transcript ?? []);
  writeJson(path.join(artifacts, "citations.json"), response.citations ?? []);
  writeJson(path.join(artifacts, "products.json"), response.products ?? []);
  writeJson(path.join(artifacts, "tool-events.json"), response.tool_events ?? []);
  writeJson(path.join(artifacts, "permission-denials.json"), response.permission_denials ?? []);
  writeJson(path.join(artifacts, "result.json"), result);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadFixture(args.fixture);
  const runner = loadRunner();
  const artifacts = path.resolve(args.artifacts);
  if (host.hasPathSegment(artifacts, ".kg")) fail("artifacts 目录不得位于 .kg 内");
  if (fs.existsSync(artifacts) && fs.readdirSync(artifacts).length > 0) fail(`artifacts 目录必须为空：${artifacts}`);
  fs.mkdirSync(artifacts, { recursive: true });

  const projectRoot = path.join(artifacts, "workspace", "project");
  const sessionArtifacts = path.join(artifacts, "session");
  fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
  fs.mkdirSync(sessionArtifacts, { recursive: true });
  fs.cpSync(loaded.projectSource, projectRoot, { recursive: true });
  const targetBaselines = new Map();
  for (const targetPath of loaded.oracle?.expected_proposal_target_paths ?? []) {
    const resolved = host.resolveSafeRelative(projectRoot, targetPath);
    if (!fs.statSync(resolved.full).isFile()) fail(`proposal oracle target 不是文件：${targetPath}`);
    targetBaselines.set(targetPath, fileSha256(resolved.full));
  }
  const installedSkill = path.join(projectRoot, ".agents", "skills", "kg-docs");
  fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
  fs.cpSync(BOOTSTRAP_SOURCE, installedSkill, { recursive: true });

  const inventoryPath = path.join(sessionArtifacts, "repository-inventory.json");
  const planPath = path.join(sessionArtifacts, "bootstrap-plan.json");
  const inventoryScript = path.join(installedSkill, "scripts", "inventory.mjs");
  const bootstrapScript = path.join(installedSkill, "scripts", "bootstrap.mjs");
  const taxonomyFile = path.join(installedSkill, "protocol", "document-taxonomy.yaml");
  let prompt;
  if (loaded.fixture.version === 1) {
    prompt =
      `请在 project_root 中为任务“${loaded.fixture.task}”执行 kg-docs brownfield bootstrap。` +
      `先运行 ${inventoryScript}，把静态 inventory 写到 ${inventoryPath}。` +
      "读取 inventory 和完成判断所需的最小安全源码集合。" +
      `把严格 JSON 的 kg.docs_bootstrap_plan 写到 ${planPath}，不得提交 ID、时间、hash、status 或输出路径。` +
      `最后运行 ${bootstrapScript}，用该 inventory 和 plan 创建 docs/architecture/overview.md。` +
      "在 products 中登记 kg.repository_inventory、kg.docs_bootstrap_plan 和 kg.project_document。" +
      "返回完整 transcript、file_reads、citations、products、tool_events 和 permission_denials。";
  } else if (loaded.fixture.version === 2) {
    prompt =
      `请在 project_root 中为任务“${loaded.fixture.task}”执行 kg-docs brownfield bootstrap。` +
      `完整阅读已安装技能说明与 ${taxonomyFile}，按 taxonomy 和模板合同准备 version 2 plan。` +
      `先运行 ${inventoryScript}，把静态 inventory 写到 ${inventoryPath}。` +
      "只读取 inventory 与完成判断所需的最小安全源码集合。" +
      `用文件写入工具把严格 JSON 的 kg.docs_bootstrap_plan 写到 ${planPath}。` +
      "不得提交 ID、时间、hash、status、序号或派生输出路径；不确定内容使用 unknown 与 missing_evidence。" +
      `最后运行 ${bootstrapScript}，用该 inventory 和 plan 创建全部 taxonomy core document drafts。` +
      "在 products 中登记 inventory、plan，并为每份实际生成的 project document 各登记一项。" +
      "返回完整 transcript、file_reads、citations、products、tool_events 和 permission_denials。";
  } else {
    prompt =
      `请在 project_root 中为任务“${loaded.fixture.task}”执行 kg-docs brownfield bootstrap。` +
      `完整阅读已安装技能说明与 ${taxonomyFile}，按 taxonomy 和模板合同准备 version 2 plan。` +
      `先运行 ${inventoryScript}，把静态 inventory 写到 ${inventoryPath}。` +
      "只读取 inventory 与完成判断所需的最小安全源码集合。" +
      `用文件写入工具把严格 JSON 的 kg.docs_bootstrap_plan 写到 ${planPath}。` +
      "已有人工目标必须使用 proposal 和精确 target_path，缺失目标使用 create；不得提交 ID、时间、hash、status、序号或派生输出路径。" +
      `最后运行 ${bootstrapScript}，用该 inventory 和 plan 完成全部 taxonomy core type。` +
      "在 products 中登记 inventory、plan、每份直接 draft、每份 proposal manifest 和每份 proposal candidate。" +
      "proposal manifest 使用 kg.docs_bootstrap_proposal，candidate 使用 kg.project_document_candidate。" +
      "返回完整 transcript、file_reads、citations、products、tool_events 和 permission_denials。";
  }
  const request = {
    protocol_version: "1.1",
    skill: "kg-docs",
    prompt,
    project_root: projectRoot,
    artifacts_dir: sessionArtifacts,
  };
  writeJson(path.join(artifacts, "request.json"), request);
  fs.writeFileSync(path.join(artifacts, "actual-prompt.txt"), `${request.prompt}\n`);

  const run = spawnSync(runner, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error) fail(`runner 启动失败：${run.error.message}`);
  fs.writeFileSync(path.join(artifacts, "runner-stdout.txt"), run.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, "runner-stderr.txt"), run.stderr ?? "");
  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch {
    fail(`runner stdout 无法解析为 JSON；stderr：${run.stderr.trim()}`);
  }
  const runnerPromptFile = path.join(sessionArtifacts, "runner-prompt.txt");
  const auditedPrompt = fs.existsSync(runnerPromptFile)
    ? `${request.prompt}\n${fs.readFileSync(runnerPromptFile, "utf8")}`
    : request.prompt;
  const oracleAudit = oracleIsolationAudit(auditedPrompt, loaded);
  writeJson(path.join(artifacts, "oracle-isolation-audit.json"), oracleAudit);
  const targetHashAudit = [...targetBaselines].map(([targetPath, beforeSha256]) => {
    const target = path.join(projectRoot, targetPath);
    return {
      target_path: targetPath,
      before_sha256: beforeSha256,
      after_sha256: fs.existsSync(target) && fs.statSync(target).isFile() ? fileSha256(target) : null,
    };
  });
  writeJson(path.join(artifacts, "target-hashes.json"), targetHashAudit);

  const result = {
    pass: false,
    session_id: response.session_id ?? null,
    failures: {
      runner_exit: [],
      runner_schema: [],
      permissions: [],
      tools: [],
      products: [],
      project_reads: [],
      oracle_isolation: [],
      deterministic_validation: [],
    },
  };
  if (run.status !== 0) result.failures.runner_exit.push(`runner exited ${run.status}: ${response.error ?? run.stderr.trim()}`);
  result.failures.runner_schema.push(...validateRunnerResponse(response));
  result.failures.permissions.push(
    ...(response.permission_denials ?? []).map(
      (denial) => `${denial.tool} denied at step ${denial.at_step}: ${denial.detail}`,
    ),
  );
  // Failed tool events are evidence, not verdicts (see eval-compile.mjs).
  result.warnings = (response.tool_events ?? [])
    .filter((event) => event?.ok === false)
    .map((event) => `${event.name} failed at step ${event.at_step}: ${event.command}`);
  result.failures.project_reads.push(...auditProjectReads(response, projectRoot));
  if (!oracleAudit.pass) result.failures.oracle_isolation.push(`oracle leaked into prompt: ${oracleAudit.leaked_values.join(", ")}`);

  let inventoryFile, planFile;
  try {
    inventoryFile = resolveArtifactProduct(
      requireProduct(response, "kg.repository_inventory"),
      sessionArtifacts,
      "inventory",
    );
    planFile = resolveArtifactProduct(
      requireProduct(response, "kg.docs_bootstrap_plan"),
      sessionArtifacts,
      "plan",
    );
    if (loaded.fixture.version === 1) {
      const documentProduct = requireProduct(response, "kg.project_document");
      const expectedDocument = path.join(projectRoot, "docs", "architecture", "overview.md");
      const declaredDocument = path.isAbsolute(documentProduct.path)
        ? path.resolve(documentProduct.path)
        : path.resolve(projectRoot, ...documentProduct.path.replaceAll("\\", "/").split("/"));
      if (host.canonicalPath(declaredDocument) !== host.canonicalPath(expectedDocument)) {
        throw new Error("project document product path is not docs/architecture/overview.md");
      }
      if (!fs.existsSync(declaredDocument) || !fs.statSync(declaredDocument).isFile()) {
        throw new Error("project document product does not exist");
      }
    } else if (loaded.fixture.version === 2) {
      requireProducts(response, "kg.project_document", loaded.oracle.expected_document_count);
    } else {
      const proposalCount = loaded.oracle.expected_proposal_target_paths.length;
      requireProducts(response, "kg.project_document", loaded.oracle.expected_document_count - proposalCount);
      requireProducts(response, "kg.docs_bootstrap_proposal", proposalCount);
      requireProducts(response, "kg.project_document_candidate", proposalCount);
    }
    result.failures.tools.push(...toolChainAudit(response, inventoryFile, planFile));
  } catch (error) {
    result.failures.products.push(error.message);
  }

  if (inventoryFile && planFile) {
    try {
      const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
      const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
      if (inventory.static_only !== true) throw new Error("inventory is not static_only");
      const check = runNode(
        bootstrapScript,
        ["--check", "--project-root", projectRoot, "--inventory", inventoryFile, "--plan", planFile],
        { cwd: projectRoot },
      );
      requireRunOk(check, "bootstrap deterministic check");
      if (loaded.fixture.version === 1) {
        const document = path.join(projectRoot, "docs", "architecture", "overview.md");
        const validate = runNode(DOCS_VALIDATE, [document], {
          cwd: projectRoot,
          env: { KG_ROOT: projectRoot },
        });
        requireRunOk(validate, "project document validation");
      } else {
        const validated = validateV2Documents({
          response,
          projectRoot,
          plan,
          inventory,
          oracle: loaded.oracle,
          targetBaselines,
        });
        if (validated.failures.length) throw new Error(validated.failures.join("; "));
        const validate = runNode(DOCS_VALIDATE, validated.targetPaths.map((target) => path.join(projectRoot, target)), {
          cwd: projectRoot,
          env: { KG_ROOT: projectRoot },
        });
        requireRunOk(validate, "project document and proposal candidate validation");
      }
      if (fs.existsSync(path.join(projectRoot, "should-not-run.executed"))) {
        throw new Error("bootstrap executed the should-not-run fixture");
      }
    } catch (error) {
      result.failures.deterministic_validation.push(error.message);
    }
  }

  result.pass = Object.values(result.failures).every((failures) => failures.length === 0);
  saveEvidence(artifacts, response, result);
  if (!result.pass) fail(`G-B bootstrap 门禁失败，详见 ${path.join(artifacts, "result.json")}`);
  console.log(`kg: G-B bootstrap 门禁通过，证据保存在 ${artifacts}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
