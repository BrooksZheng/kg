// Provider-neutral kg-spec evaluator. Fixture mode proves deterministic
// synthesis without a provider. Real mode invokes one agent session, then
// delegates rendering and validation to produce-spec.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "./lib/kyaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCE = path.join(ROOT, "skills", "kg-spec", "scripts", "produce-spec.mjs");
const FIXTURE_FIELDS = [
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

function loadFixture(value) {
  const file = resolveDeclared(value);
  if (!fs.existsSync(file)) fail(`夹具不存在：${file}`);
  const fixture = parse(fs.readFileSync(file, "utf8"));
  const unknown = Object.keys(fixture).filter((key) => !FIXTURE_FIELDS.includes(key));
  if (unknown.length) fail(`spec fixture 含未知字段：${unknown.join(", ")}`);
  if (fixture.kind !== "kg.eval_spec_fixture" || fixture.version !== 1) fail("spec fixture 的 kind/version 无效");
  for (const field of ["project_root", "kickoff_fixture", "transcript", "synthesis", "expected_spec", "required_sections"]) {
    if (typeof fixture[field] !== "string" || fixture[field].trim() === "") fail(`spec fixture 缺少 ${field}`);
  }
  if (fixture.c1_zero_interview_score !== 4 || fixture.forbid_user_questions !== true) {
    fail("spec fixture 必须要求零访谈 C1 满分 4");
  }
  const paths = {
    projectRoot: resolveDeclared(fixture.project_root),
    kickoffFixture: resolveDeclared(fixture.kickoff_fixture),
    transcript: resolveDeclared(fixture.transcript),
    synthesis: resolveDeclared(fixture.synthesis),
    expected: resolveDeclared(fixture.expected_spec),
  };
  for (const [label, target] of Object.entries(paths)) {
    if (!fs.existsSync(target)) fail(`spec fixture 的 ${label} 不存在：${target}`);
  }
  return { fixture, file, ...paths, projectRoot: fs.realpathSync(paths.projectRoot) };
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function requireRunOk(run, label) {
  if (run.error) throw new Error(`${label} 启动失败：${run.error.message}`);
  if (run.status !== 0) throw new Error(`${label} 失败：${(run.stderr || run.stdout).trim()}`);
}

function normalizeGeneratedCreatedAt(text) {
  const matches = text.match(/^created_at: .+$/gm) ?? [];
  if (matches.length !== 1) throw new Error("generated spec must contain exactly one created_at field");
  return text.replace(/^created_at: .+$/m, "created_at: <generated>");
}

function runFixtureCheck(fixturePath) {
  const loaded = loadFixture(fixturePath);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kg-spec-fixture-"));
  try {
    const packet = path.join(temp, "packet.json");
    const spec = path.join(temp, "spec.md");
    requireRunOk(
      runNode([PRODUCE, "--prepare", "--project-root", loaded.projectRoot, "--transcript", loaded.transcript, "--output", packet]),
      "prepare",
    );
    requireRunOk(
      runNode([
        PRODUCE,
        "--finalize",
        "--project-root",
        loaded.projectRoot,
        "--packet",
        packet,
        "--synthesis",
        loaded.synthesis,
        "--output",
        spec,
      ]),
      "finalize",
    );
    requireRunOk(runNode([PRODUCE, "--check", spec, "--project-root", loaded.projectRoot]), "check");
    const actual = fs.readFileSync(spec, "utf8");
    const expected = fs.readFileSync(loaded.expected, "utf8");
    if (normalizeGeneratedCreatedAt(actual) !== expected) {
      throw new Error("spec structure differs from expected/task-spec.md");
    }
    for (const section of loaded.fixture.required_sections.split("|")) {
      if (!actual.includes(`## ${section}\n`)) throw new Error(`expected spec missing section ${section}`);
    }
  } catch (error) {
    fail(`spec 夹具判定失败：${error.message}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("kg: spec 夹具检查通过，零访谈、八章节、稳定锚点与确定性输出判据全部命中");
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

function validateResponse(response) {
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

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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

function resolveProduct(artifacts, response) {
  const product = response.products.find((item) => item?.kind === "kg.spec_synthesis");
  if (!product || typeof product.path !== "string") throw new Error("runner 未返回 kg.spec_synthesis 产物");
  const declaredRoot = path.resolve(artifacts);
  const root = canonicalizeWithMissingTail(declaredRoot);
  const declaredFile = path.isAbsolute(product.path)
    ? path.resolve(product.path)
    : path.resolve(declaredRoot, product.path);
  const file = canonicalizeWithMissingTail(declaredFile);
  if (isOutside(root, file)) {
    throw new Error("runner synthesis 产物超出 artifacts_dir");
  }
  if (
    !fs.existsSync(declaredFile) ||
    !fs.statSync(declaredFile).isFile() ||
    fs.lstatSync(declaredFile).isSymbolicLink()
  ) {
    throw new Error("runner synthesis 产物不存在或为符号链接");
  }
  return declaredFile;
}

function questionAudit(response) {
  const failures = [];
  for (const [index, message] of (response.transcript ?? []).entries()) {
    if (message?.role === "assistant" && /[?？]/.test(String(message.content ?? ""))) {
      failures.push(`assistant message ${index} contains a user question`);
    }
    for (const call of message?.tool_calls ?? []) {
      const name = String(call?.name ?? call?.function?.name ?? "");
      if (/ask|question|request_user_input/i.test(name)) failures.push(`assistant message ${index} called ${name}`);
    }
  }
  for (const [index, event] of (response.events ?? []).entries()) {
    if (/ask|question|request_user_input/i.test(String(event?.type ?? event?.name ?? ""))) {
      failures.push(`event ${index} is a follow-up question`);
    }
  }
  return failures;
}

function citationAudit(response, projectRoot) {
  const failures = [];
  if ((response.citations ?? []).length === 0) failures.push("runner returned no citations");
  for (const citation of response.citations ?? []) {
    if (typeof citation?.path !== "string" || path.isAbsolute(citation.path)) {
      failures.push("citation path must be project-relative");
      continue;
    }
    const portable = citation.path.replaceAll("\\", "/");
    if (portable.split("/").includes("..")) {
      failures.push(`citation path rejected: ${citation.path}`);
      continue;
    }
    const normalized = path.posix.normalize(portable);
    const normalizedLower = normalized.toLowerCase();
    if (normalized.startsWith("../") || normalizedLower === ".kg" || normalizedLower.startsWith(".kg/")) {
      failures.push(`citation path rejected: ${citation.path}`);
      continue;
    }
    const full = path.resolve(projectRoot, ...normalized.split("/"));
    const relative = path.relative(projectRoot, full);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !fs.existsSync(full) ||
      !fs.statSync(full).isFile()
    ) {
      failures.push(`citation file missing: ${citation.path}`);
    }
  }
  return failures;
}

function runReal(fixturePath, transcriptValue, artifactsValue) {
  if (!transcriptValue) fail("真实评测缺少 --transcript");
  if (!artifactsValue) fail("真实评测缺少 --artifacts");
  const loaded = loadFixture(fixturePath);
  const transcript = path.resolve(transcriptValue);
  if (!fs.existsSync(transcript)) fail(`kickoff transcript 不存在：${transcript}`);
  const runner = loadRunner();
  const artifacts = path.resolve(artifactsValue);
  fs.mkdirSync(artifacts, { recursive: true });
  const packet = path.join(artifacts, "spec-packet.json");
  const prepare = runNode([
    PRODUCE,
    "--prepare",
    "--project-root",
    loaded.projectRoot,
    "--transcript",
    transcript,
    "--output",
    packet,
  ]);
  try {
    requireRunOk(prepare, "prepare");
  } catch (error) {
    fail(error.message);
  }
  const request = {
    protocol_version: "1.0",
    skill: "kg-spec",
    prompt:
      "读取 artifacts_dir 中的只读 spec-packet.json，零访谈完成语义综合。" +
      "不要向用户提出任何新问题。把严格 KYAML 写为 artifacts_dir/spec-synthesis.yaml，products 中登记 kind kg.spec_synthesis。",
    project_root: loaded.projectRoot,
    artifacts_dir: artifacts,
    config: {
      packet_path: packet,
      synthesis_path: path.join(artifacts, "spec-synthesis.yaml"),
      required_sections: loaded.fixture.required_sections.split("|"),
      zero_interview_required: true,
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
  writeJson(path.join(artifacts, "runner-output.json"), response);
  if (run.status !== 0) fail(`runner 退出码 ${run.status}：${response.error ?? run.stderr.trim() ?? "未提供错误信息"}`);

  const schemaFailures = validateResponse(response);
  const questionFailures = questionAudit(response);
  const citationFailures = citationAudit(response, loaded.projectRoot);
  const executionFailures = [
    ...(response.permission_denials ?? []).map(
      (denial) => `permission denied for ${denial.tool} at step ${denial.at_step}: ${denial.detail}`,
    ),
    ...(response.tool_events ?? [])
      .filter((event) => event?.ok === false)
      .map((event) => `tool failed at step ${event.at_step}: ${event.name} ${event.command}`),
  ];
  let synthesisFile = null;
  let specFailures = [];
  try {
    synthesisFile = resolveProduct(artifacts, response);
    const finalize = runNode([
      PRODUCE,
      "--finalize",
      "--project-root",
      loaded.projectRoot,
      "--packet",
      packet,
      "--synthesis",
      synthesisFile,
      "--output",
      path.join(artifacts, "spec.md"),
    ]);
    requireRunOk(finalize, "finalize");
    const check = runNode([
      PRODUCE,
      "--check",
      path.join(artifacts, "spec.md"),
      "--project-root",
      loaded.projectRoot,
    ]);
    requireRunOk(check, "check");
  } catch (error) {
    specFailures = [error.message];
  }
  writeJson(path.join(artifacts, "citations.json"), response.citations ?? []);
  const c1Score = questionFailures.length === 0 ? 4 : 0;
  const result = {
    pass: false,
    session_id: response.session_id ?? null,
    c1_zero_interview_score: c1Score,
    schema_pass: schemaFailures.length === 0 && specFailures.length === 0,
    references_pass: citationFailures.length === 0 && specFailures.length === 0,
    no_followup_pass: questionFailures.length === 0,
    runner_execution_pass: executionFailures.length === 0,
    failures: {
      runner_schema: schemaFailures,
      runner_execution: executionFailures,
      questions: questionFailures,
      citations: citationFailures,
      spec: specFailures,
    },
  };
  result.pass =
    result.c1_zero_interview_score === 4 &&
    result.schema_pass &&
    result.references_pass &&
    result.no_followup_pass &&
    result.runner_execution_pass;
  writeJson(path.join(artifacts, "result.json"), result);
  if (!result.pass) fail(`真实 kg-spec 门禁失败，详见 ${path.join(artifacts, "result.json")}`);
  console.log(`kg: 真实 kg-spec 门禁通过，产物已保存到 ${artifacts}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.check_fixture) {
    if (args.fixture || args.transcript || args.artifacts) fail("--check-fixture 不能与真实评测参数混用");
    runFixtureCheck(args.check_fixture);
    return;
  }
  if (!args.fixture) fail("真实评测缺少 --fixture");
  runReal(args.fixture, args.transcript, args.artifacts);
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
