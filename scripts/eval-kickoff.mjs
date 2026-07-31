// Provider-neutral kickoff evaluator. Fixture mode validates the hand-built
// oracle without a runner. Real mode runs one agent session and saves all
// required evaluation artifacts.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "./lib/kyaml.mjs";
import * as documentAnchor from "./lib/document-anchor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_FIELDS = [
  "kind",
  "version",
  "task",
  "project_root",
  "transcript",
  "must_find",
  "must_ask",
  "must_report",
  "distractors",
  "forbid_fabrication",
];

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`无法识别参数 ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} 缺少值`);
    out[arg.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  return out;
}

function resolveDeclared(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function rejectUnknown(record, allowed, label) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} 含未知字段：${unknown.join(", ")}`);
}

function requireStringList(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
    fail(`${label} 必须是非空字符串列表`);
  }
  return value;
}

function tokenize(expectation) {
  return expectation.trim().split(/\s+/);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function validateTokenExpectations(fixture, projectRoot) {
  for (const field of ["must_find", "must_ask"]) {
    for (const expectation of fixture[field]) {
      const shortTokens = tokenize(expectation).filter((token) => codePointLength(token) < 2);
      if (shortTokens.length) {
        fail(`${field} 的 token 必须至少包含 2 个 Unicode 码点：${shortTokens.join(", ")}`);
      }
    }
  }
  for (const expectation of fixture.must_report) {
    try {
      documentAnchor.validateStableDocumentReference({ sourcePath: expectation, projectRoot });
    } catch (error) {
      fail(`must_report 必须是合法的稳定文档相对路径：${documentAnchor.formatDocumentAnchorErrorZh(error)}`);
    }
  }
}

function loadFixture(file) {
  const fixtureFile = resolveDeclared(file);
  if (!fs.existsSync(fixtureFile)) fail(`夹具不存在：${fixtureFile}`);
  const fixture = parse(fs.readFileSync(fixtureFile, "utf8"));
  rejectUnknown(fixture, FIXTURE_FIELDS, "kickoff fixture");
  if (fixture.kind !== "kg.eval_kickoff_fixture" || fixture.version !== 1) {
    fail("kickoff fixture 的 kind/version 无效");
  }
  for (const field of ["task", "project_root", "transcript"]) {
    if (typeof fixture[field] !== "string" || fixture[field].trim() === "") fail(`kickoff fixture 缺少 ${field}`);
  }
  for (const field of ["must_find", "must_ask", "must_report", "distractors", "forbid_fabrication"]) {
    requireStringList(fixture[field], field);
  }
  const projectRoot = resolveDeclared(fixture.project_root);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) fail(`夹具项目不存在：${projectRoot}`);
  const realProjectRoot = fs.realpathSync(projectRoot);
  validateTokenExpectations(fixture, realProjectRoot);
  const transcriptFile = resolveDeclared(fixture.transcript);
  if (!fs.existsSync(transcriptFile)) fail(`夹具 transcript 不存在：${transcriptFile}`);
  return { fixture, fixtureFile, projectRoot: realProjectRoot, transcriptFile };
}

function validateRunnerResponse(response) {
  const errors = [];
  if (response === null || typeof response !== "object" || Array.isArray(response)) return ["runner response must be an object"];
  if (typeof response.session_id !== "string" || response.session_id.trim() === "") errors.push("session_id missing");
  for (const field of ["transcript", "file_reads", "citations", "products"]) {
    if (!Array.isArray(response[field])) errors.push(`${field} must be an array`);
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
  }
  for (const [index, product] of (response.products ?? []).entries()) {
    if (typeof product?.kind !== "string" || typeof product?.path !== "string") {
      errors.push(`products[${index}] must contain kind and path`);
    }
  }
  if (response.tool_events !== undefined && !Array.isArray(response.tool_events)) {
    errors.push("tool_events must be an array when present");
  }
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
  if (response.permission_denials !== undefined && !Array.isArray(response.permission_denials)) {
    errors.push("permission_denials must be an array when present");
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
  return errors;
}

function resolveProjectFile(projectRoot, rel) {
  if (!rel || path.isAbsolute(rel)) throw new Error(`路径必须是项目内相对路径：${rel}`);
  const portable = rel.replaceAll("\\", "/");
  if (portable.split("/").includes("..")) throw new Error(`拒绝隔离或逃逸路径：${rel}`);
  const normalized = path.posix.normalize(portable);
  const normalizedLower = normalized.toLowerCase();
  if (normalizedLower === ".kg" || normalizedLower.startsWith(".kg/") || normalized.startsWith("../")) {
    throw new Error(`拒绝隔离或逃逸路径：${rel}`);
  }
  const full = path.resolve(projectRoot, ...normalized.split("/"));
  const relative = path.relative(projectRoot, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径逃逸：${rel}`);
  }
  let current = projectRoot;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`符号链接引用：${rel}`);
  }
  return { full, normalized };
}

function canonicalizeWithMissingTail(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try {
      return path.resolve(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function symbolicLinksOnPath(target) {
  const absolute = path.resolve(target);
  const filesystemRoot = path.parse(absolute).root;
  const relative = path.relative(filesystemRoot, absolute);
  const links = [];
  let current = filesystemRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) break;
      throw error;
    }
    if (stat.isSymbolicLink()) links.push(path.resolve(current));
  }
  return links;
}

function resolveProductFile(productPath, productRoot) {
  if (typeof productPath !== "string" || productPath.trim() === "") {
    throw new Error("kg.kickoff_conflicts 产物路径为空");
  }
  const declaredRoot = path.resolve(productRoot);
  const root = canonicalizeWithMissingTail(declaredRoot);
  const declaredFile = path.isAbsolute(productPath)
    ? path.resolve(productPath)
    : path.resolve(declaredRoot, ...productPath.replaceAll("\\", "/").split("/"));
  const file = canonicalizeWithMissingTail(declaredFile);
  if (isOutside(root, file)) {
    throw new Error("kg.kickoff_conflicts 产物超出允许的产物根目录");
  }
  if (
    declaredFile.split(path.sep).some((segment) => segment.toLowerCase() === ".kg") ||
    file.split(path.sep).some((segment) => segment.toLowerCase() === ".kg")
  ) {
    throw new Error("kg.kickoff_conflicts 产物路径不得位于 .kg");
  }
  const rootLinks = new Set(symbolicLinksOnPath(declaredRoot));
  for (const link of symbolicLinksOnPath(declaredFile)) {
    if (!rootLinks.has(link)) {
      throw new Error("kg.kickoff_conflicts 产物路径不得包含符号链接");
    }
  }
  if (!fs.existsSync(declaredFile) || !fs.statSync(declaredFile).isFile()) {
    throw new Error("kg.kickoff_conflicts 产物不存在或不是文件");
  }
  return declaredFile;
}

function parseConflictProduct(file, projectRoot) {
  const content = fs.readFileSync(file, "utf8");
  let raw;
  try {
    raw = path.extname(file).toLowerCase() === ".json" || content.trimStart().startsWith("{")
      ? JSON.parse(content)
      : parse(content);
  } catch (error) {
    throw new Error(`kg.kickoff_conflicts 产物无法解析：${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("kg.kickoff_conflicts 产物必须是对象");
  }
  const unknownTop = Object.keys(raw).filter((key) => !["kind", "version", "conflicts"].includes(key));
  if (unknownTop.length) throw new Error(`kg.kickoff_conflicts 产物含未知字段：${unknownTop.join(", ")}`);
  if (raw.kind !== "kg.kickoff_conflicts" || raw.version !== 1 || !Array.isArray(raw.conflicts)) {
    throw new Error("kg.kickoff_conflicts 产物的 kind、version 或 conflicts 无效");
  }
  return raw.conflicts.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`kg.kickoff_conflicts.conflicts[${index}] 必须是对象`);
    }
    const unknown = Object.keys(item).filter((key) => !["summary", "source_path", "line"].includes(key));
    if (unknown.length) throw new Error(`kg.kickoff_conflicts.conflicts[${index}] 含未知字段：${unknown.join(", ")}`);
    if (typeof item.summary !== "string" || item.summary.trim() === "") {
      throw new Error(`kg.kickoff_conflicts.conflicts[${index}].summary 无效`);
    }
    if (!Number.isInteger(item.line) || item.line < 1) {
      throw new Error(`kg.kickoff_conflicts.conflicts[${index}].line 无效`);
    }
    try {
      return documentAnchor.validateStableDocumentReference({
        sourcePath: item.source_path,
        line: item.line,
        projectRoot,
      }).sourcePath;
    } catch (error) {
      throw new Error(
        `kg.kickoff_conflicts.conflicts[${index}] 无效：${documentAnchor.formatDocumentAnchorErrorZh(error)}`,
      );
    }
  });
}

function auditMustReport(fixture, response, projectRoot, productRoot) {
  const product = (response.products ?? []).find((item) => item?.kind === "kg.kickoff_conflicts");
  if (!product) {
    if (fixture.must_report.length === 0) return { missing: [], failures: [] };
    return { missing: [...fixture.must_report], failures: ["runner 未返回 kg.kickoff_conflicts 产物"] };
  }
  try {
    const file = resolveProductFile(product.path, productRoot);
    const parsed = parseConflictProduct(file, projectRoot);
    if (fixture.must_report.length === 0 && parsed.length > 0) {
      return {
        missing: [],
        failures: ["夹具期望无冲突，但 kg.kickoff_conflicts 产物记录了冲突"],
      };
    }
    const reported = new Set(parsed);
    return {
      missing: fixture.must_report.filter((expected) => !reported.has(expected)),
      failures: [],
    };
  } catch (error) {
    return { missing: [...fixture.must_report], failures: [error.message] };
  }
}

function evaluate(fixture, response, projectRoot, productRoot) {
  const schemaErrors = validateRunnerResponse(response);
  const combined = (response.transcript ?? []).map((message) => message.content).join("\n");
  const allTokensPresent = (expectation) => tokenize(expectation).every((token) => combined.includes(token));
  const missingFind = fixture.must_find.filter((needle) => !allTokensPresent(needle));
  const missingAsk = fixture.must_ask.filter((needle) => !allTokensPresent(needle));
  const reportAudit = auditMustReport(fixture, response, projectRoot, productRoot);
  const fabricated = fixture.forbid_fabrication.filter((needle) => combined.includes(needle));
  const questionFailures = [];
  for (const [index, message] of (response.transcript ?? []).entries()) {
    if (message.role !== "assistant") continue;
    const count = (message.content.match(/[?？]/g) ?? []).length;
    if (count > 1) questionFailures.push(`assistant message ${index} asks ${count} questions`);
    if (count === 1 && (!message.content.includes("推荐") || !message.content.includes("理由"))) {
      questionFailures.push(`assistant message ${index} lacks recommendation or reason`);
    }
  }
  const readFailures = [];
  for (const read of response.file_reads ?? []) {
    try {
      const { normalized } = resolveProjectFile(projectRoot, read.path);
      if (fixture.distractors.includes(normalized)) readFailures.push(`深读了干扰文档 ${normalized}`);
      if (!fs.existsSync(path.join(projectRoot, normalized))) readFailures.push(`读取记录指向不存在文件 ${normalized}`);
    } catch (error) {
      readFailures.push(error.message);
    }
  }
  const citationFailures = [];
  if ((response.citations ?? []).length === 0) citationFailures.push("没有引用");
  for (const citation of response.citations ?? []) {
    try {
      const { full, normalized } = resolveProjectFile(projectRoot, citation.path);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        citationFailures.push(`引用文件不存在 ${normalized}`);
        continue;
      }
      if (citation.line !== undefined) {
        if (!Number.isInteger(citation.line) || citation.line < 1) {
          citationFailures.push(`引用行号无效 ${normalized}`);
        } else {
          const count = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
          if (citation.line > count) citationFailures.push(`引用行号越界 ${normalized}:${citation.line}`);
        }
      }
    } catch (error) {
      citationFailures.push(error.message);
    }
  }
  const executionFailures = [
    ...(response.permission_denials ?? []).map(
      (denial) => `permission denied for ${denial.tool} at step ${denial.at_step}: ${denial.detail}`,
    ),
    ...(response.tool_events ?? [])
      .filter((event) => event?.ok === false)
      .map((event) => `tool failed at step ${event.at_step}: ${event.name} ${event.command}`),
  ];
  const result = {
    pass: false,
    hard_gate_pass: false,
    session_id: response.session_id ?? null,
    must_find: { pass: missingFind.length === 0, missing: missingFind },
    must_ask: { pass: missingAsk.length === 0, missing: missingAsk },
    must_report: {
      pass: reportAudit.missing.length === 0 && reportAudit.failures.length === 0,
      missing: reportAudit.missing,
      failures: reportAudit.failures,
    },
    forbid_fabrication: { pass: fabricated.length === 0, found: fabricated },
    one_question_per_turn: { pass: questionFailures.length === 0, failures: questionFailures },
    file_read_policy: { pass: readFailures.length === 0, failures: readFailures },
    citations: { pass: citationFailures.length === 0, failures: citationFailures },
    runner_schema: { pass: schemaErrors.length === 0, failures: schemaErrors },
    runner_execution: { pass: executionFailures.length === 0, failures: executionFailures },
  };
  result.hard_gate_pass = [
    result.must_find,
    result.must_ask,
    result.must_report,
    result.forbid_fabrication,
    result.one_question_per_turn,
    result.file_read_policy,
    result.citations,
    result.runner_schema,
    result.runner_execution,
  ].every((item) => item.pass);
  result.pass = result.hard_gate_pass;
  return result;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runFixtureCheck(fixturePath) {
  const { fixture, projectRoot, transcriptFile } = loadFixture(fixturePath);
  const response = JSON.parse(fs.readFileSync(transcriptFile, "utf8"));
  const result = evaluate(fixture, response, projectRoot, projectRoot);
  if (!result.pass) fail(`kickoff 夹具判定失败：${JSON.stringify(result)}`);
  console.log("kg: kickoff 夹具检查通过，检索、单问题、冲突报告与反虚构判据全部命中");
}

function loadRunner() {
  const runner = process.env.KG_EVAL_RUNNER;
  if (!runner) fail("缺少 KG_EVAL_RUNNER；真实评测需要当前 provider 的可执行 runner 绝对路径");
  if (!path.isAbsolute(runner)) fail("KG_EVAL_RUNNER 必须是绝对路径");
  try {
    fs.accessSync(runner, fs.constants.X_OK);
  } catch {
    fail(`KG_EVAL_RUNNER 不可执行：${runner}`);
  }
  return runner;
}

function runReal(fixturePath, artifactsValue) {
  if (!artifactsValue) fail("真实评测缺少 --artifacts");
  const { fixture, projectRoot } = loadFixture(fixturePath);
  const runner = loadRunner();
  const artifacts = path.resolve(artifactsValue);
  fs.mkdirSync(artifacts, { recursive: true });
  const request = {
    protocol_version: "1.0",
    skill: "kg-kickoff",
    prompt:
      `请为任务“${fixture.task}”执行 kg-kickoff。必须先索引、再只深读相关文档。` +
      "每轮最多问一个问题，问题必须同时给出推荐答案和理由。返回完整 transcript、file_reads、citations 和 products。",
    project_root: projectRoot,
    artifacts_dir: artifacts,
    config: {
      must_find: fixture.must_find,
      must_ask: fixture.must_ask,
      must_report: fixture.must_report,
      distractors: fixture.distractors,
      forbid_fabrication: fixture.forbid_fabrication,
    },
  };
  writeJson(path.join(artifacts, "request.json"), request);
  const run = spawnSync(runner, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) fail(`runner 启动失败：${run.error.message}`);
  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch {
    fail(`runner stdout 不是 JSON；stderr：${run.stderr.trim()}`);
  }
  if (run.status !== 0) {
    fail(`runner 退出码 ${run.status}：${response.error ?? run.stderr.trim() ?? "未提供错误信息"}`);
  }
  const result = evaluate(fixture, response, projectRoot, artifacts);
  writeJson(path.join(artifacts, "transcript.json"), response.transcript);
  writeJson(path.join(artifacts, "citations.json"), response.citations);
  writeJson(path.join(artifacts, "result.json"), result);
  if (!result.pass) fail(`真实 kickoff 门禁失败，详见 ${path.join(artifacts, "result.json")}`);
  console.log(`kg: 真实 kickoff 门禁通过，产物已保存到 ${artifacts}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.check_fixture) {
    if (args.fixture || args.artifacts) fail("--check-fixture 不能与真实评测参数混用");
    runFixtureCheck(args.check_fixture);
    return;
  }
  if (!args.fixture) fail("真实评测缺少 --fixture");
  runReal(args.fixture, args.artifacts);
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
