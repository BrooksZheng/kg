// G-D compile evaluator. It follows Runner Contract 1.1 and accepts only
// sessions that read every prescribed input, submit the JSON plan with a
// non-shell tool, invoke apply-compile-plan.mjs, and leave valid machine state.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as host from "./lib/host.mjs";
import { auditR42 } from "./lib/eval-r42.mjs";
import { isScriptInvocation, isShellToolName } from "./lib/eval-tool-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPILE_SOURCE = path.join(ROOT, "skills", "kg-compile");
const FIXTURE_FIELDS = ["kind", "version", "project_source", "task"];

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
  if (!out.fixture || !out.artifacts) fail("用法：eval-compile.mjs --fixture <fixture.json> --artifacts <empty-dir>");
  return out;
}

function resolveDeclared(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function loadFixture(value) {
  const file = resolveDeclared(value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`夹具不存在：${file}`);
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(file, "utf8"));
    exactFields(fixture, FIXTURE_FIELDS, "compile fixture");
  } catch (error) {
    fail(`夹具 JSON 无效：${error.message}`);
  }
  if (fixture.kind !== "kg.eval_compile_fixture" || fixture.version !== 1) fail("compile fixture 的 kind/version 无效");
  if (typeof fixture.task !== "string" || fixture.task.trim() === "") fail("compile fixture 缺少 task");
  const projectSource = resolveDeclared(fixture.project_source);
  if (!fs.existsSync(projectSource) || !fs.statSync(projectSource).isDirectory()) {
    fail(`compile fixture 项目不存在：${projectSource}`);
  }
  return { fixture, projectSource };
}

function loadRunner() {
  const runner = process.env.KG_EVAL_RUNNER;
  if (!runner) fail("缺少 KG_EVAL_RUNNER；真实 G-D 门禁需要可执行 runner 的绝对路径");
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

function validateRunnerResponse(response) {
  const errors = [];
  if (response === null || typeof response !== "object" || Array.isArray(response)) return ["runner response must be an object"];
  if (typeof response.session_id !== "string" || response.session_id.trim() === "") errors.push("session_id missing");
  for (const field of ["transcript", "file_reads", "citations", "products", "tool_events"]) {
    if (!Array.isArray(response[field])) errors.push(`${field} must be an array`);
  }
  if (response.permission_denials !== undefined && !Array.isArray(response.permission_denials)) {
    errors.push("permission_denials must be an array when present");
  }
  for (const [index, event] of (response.tool_events ?? []).entries()) {
    if (
      typeof event?.name !== "string" ||
      typeof event?.command !== "string" ||
      !Number.isInteger(event?.at_step) ||
      typeof event?.ok !== "boolean"
    ) {
      errors.push(`tool_events[${index}] must contain name, command, integer at_step, and ok`);
    }
  }
  for (const [index, read] of (response.file_reads ?? []).entries()) {
    if (typeof read?.path !== "string" || !Number.isInteger(read?.at_step)) {
      errors.push(`file_reads[${index}] must contain path and integer at_step`);
    }
  }
  for (const [index, product] of (response.products ?? []).entries()) {
    if (typeof product?.kind !== "string" || typeof product?.path !== "string") {
      errors.push(`products[${index}] must contain kind and path`);
    }
  }
  return errors;
}

function requireProduct(response, kind) {
  const matches = (response.products ?? []).filter((product) => product?.kind === kind);
  if (matches.length !== 1) throw new Error(`runner must return exactly one ${kind} product`);
  return matches[0];
}

function resolveProduct(product, allowedRoot, label) {
  const file = path.resolve(product.path);
  if (host.hasPathSegment(file, ".kg") && label !== "report") {
    throw new Error(`${label} product must not be inside .kg`);
  }
  if (host.isOutside(allowedRoot, file)) throw new Error(`${label} product escapes its allowed root`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} product does not exist`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} product must not be a symbolic link`);
  return file;
}

function requiredInputPaths(context) {
  return [
    ...context.observations.map((input) => input.path),
    ...context.knowledge_entries.map((input) => input.path),
    ...context.accepted_documents.map((input) => input.path),
    ...context.artifacts.flatMap((artifact) => [artifact.sidecar_path, artifact.target_path]),
  ].sort();
}

function auditToolChain(response, context, planFile) {
  const failures = [];
  const events = response.tool_events ?? [];
  const compile = events.find(
    (event) => isScriptInvocation(event, "compile.mjs") && event.command.includes("--output"),
  );
  const plan = events.find(
    (event) => event.ok && !isShellToolName(event.name) && event.command.includes(path.basename(planFile)),
  );
  const apply = events.find(
    (event) =>
      event.ok &&
      isScriptInvocation(event, "apply-compile-plan.mjs") &&
      event.command.includes("--context") &&
      event.command.includes("--plan"),
  );
  if (!compile) failures.push("compile.mjs tool event missing");
  if (!plan) failures.push("JSON compile plan submission tool event missing");
  if (!apply) failures.push("apply-compile-plan.mjs tool event missing");
  if (compile && plan && apply && !(compile.at_step < plan.at_step && plan.at_step < apply.at_step)) {
    failures.push("tool chain order must be compile context, JSON plan submission, apply");
  }
  // A read counts as long as it precedes plan submission. Requiring it to
  // follow context generation over-reads the contract: agents legitimately
  // explore the host before running the harness, and input drift between an
  // early read and the plan is caught deterministically by context
  // fingerprints plus apply preflight, not by event ordering.
  const reads = response.file_reads ?? [];
  const earliestByPath = new Map();
  for (const read of reads) {
    const known = earliestByPath.get(read.path);
    if (!known || read.at_step < known.at_step) earliestByPath.set(read.path, read);
  }
  for (const required of requiredInputPaths(context)) {
    const read = earliestByPath.get(required);
    if (!read) {
      failures.push(`required compile input was not read: ${required}`);
      continue;
    }
    if (plan && !(read.at_step < plan.at_step)) {
      failures.push(`required compile input was read only after plan submission: ${required}`);
    }
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
  const installedSkill = path.join(projectRoot, ".agents", "skills", "kg-compile");
  fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
  fs.cpSync(COMPILE_SOURCE, installedSkill, { recursive: true });

  const contextPath = path.join(sessionArtifacts, "compile-context.json");
  const planPath = path.join(sessionArtifacts, "compile-plan.json");
  const compileScript = path.join(installedSkill, "scripts", "compile.mjs");
  const applyScript = path.join(installedSkill, "scripts", "apply-compile-plan.mjs");
  const request = {
    protocol_version: "1.1",
    skill: "kg-compile",
    prompt:
      `请在 project_root 中执行任务“${loaded.fixture.task}”。` +
      `先运行 ${compileScript}，把 compile context 写到 ${contextPath}。` +
      "逐一读取 context 声明的 pending observations、全部 knowledge entries、accepted documents、harness sidecars 和目标文档。" +
      `用非 shell 文件写入工具把严格 JSON 的 kg.compile_plan 提交到 ${planPath}。` +
      "R4.2 update、merge、ownership、proposal 任务必须提交 version 2 plan，并按 protocol 选择 add、update、merge、demote、retire、candidate 或 no_change；其他任务使用 version 1 的 publish_kn_and_carrier、queue_only 或 no_change。plan 不得提交 ID、时间、hash、状态、输出路径或脚本职责字段。" +
      `最后真正运行 ${applyScript}，消费 context 和 plan。` +
      "在 products 中登记 kg.compile_context、kg.compile_plan 和 kg.compile_report，并返回 Runner Contract 1.1 的完整证据。",
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
  // Failed tool events are evidence, not verdicts: the contract demands
  // positive proof of the required chain, and an ENOENT exploration probe
  // says nothing about it. Denials stay fatal because they mean the harness
  // could not run at all.
  result.warnings = (response.tool_events ?? [])
    .filter((event) => event?.ok === false)
    .map((event) => `${event.name} failed at step ${event.at_step}: ${event.command}`);
  for (const read of response.file_reads ?? []) {
    try {
      host.resolveSafeRelative(projectRoot, read.path, { mustExist: false, forbidKg: false });
    } catch (error) {
      result.failures.project_reads.push(`invalid project read ${read.path}: ${error.message}`);
    }
  }

  let contextFile, planFile, reportFile, context;
  try {
    contextFile = resolveProduct(requireProduct(response, "kg.compile_context"), sessionArtifacts, "context");
    planFile = resolveProduct(requireProduct(response, "kg.compile_plan"), sessionArtifacts, "plan");
    reportFile = resolveProduct(requireProduct(response, "kg.compile_report"), projectRoot, "report");
    context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
    result.failures.tools.push(...auditToolChain(response, context, planFile));
  } catch (error) {
    result.failures.products.push(error.message);
  }

  if (contextFile && planFile && reportFile) {
    try {
      const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
      const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      if (plan.version === 2) {
        const audit = auditR42({ root: projectRoot, context, report, plan, prompt: request.prompt, routingFile: path.join(ROOT, "protocol", "routing.yaml") });
        result.failures.deterministic_validation.push(...audit.failures);
      } else {
        for (const type of ["publish_kn_and_carrier", "queue_only", "no_change"]) {
          if (report.results?.[type]?.length !== 1) throw new Error(`compile report result group ${type} must contain one item`);
        }
        if (!Array.isArray(report.known_limitations) || report.known_limitations.length !== 1) {
          throw new Error("compile report known_limitations is missing");
        }
      }
      if (fs.readdirSync(path.join(projectRoot, ".kg", "observations")).some((name) => name.endsWith(".yaml"))) {
        throw new Error("pending observations remain after G-D compile");
      }
      const processed = fs
        .readdirSync(path.join(projectRoot, ".kg", "observations", "processed"))
        .filter((name) => name.endsWith(".yaml"));
      if (processed.length !== context.observations.length) throw new Error("G-D processed observation count mismatch");
      const check = runNode(
        applyScript,
        ["--check", "--root", projectRoot, "--context", contextFile, "--plan", planFile],
        { cwd: projectRoot, env: { KG_ROOT: projectRoot } },
      );
      if (check.error || check.status !== 0) {
        throw new Error(`apply deterministic check failed: ${(check.stderr || check.error?.message || "").trim()}`);
      }
    } catch (error) {
      result.failures.deterministic_validation.push(error.message);
    }
  }

  result.pass = Object.values(result.failures).every((failures) => failures.length === 0);
  saveEvidence(artifacts, response, result);
  if (!result.pass) fail(`G-D compile 门禁失败，详见 ${path.join(artifacts, "result.json")}`);
  console.log(`kg: G-D compile 门禁通过，证据保存在 ${artifacts}`);
}

main();
