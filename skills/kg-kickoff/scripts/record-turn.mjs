// Validate agent-authored kickoff semantics against a transcript snapshot and
// write the canonical kg.kickoff_turn product. Script-owned envelope fields
// never appear in the agent JSON input.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, host, kyaml, machineContract, protocol } from "./_lib.mjs";

const TURN_SCHEMA = protocol.loadKickoffTurnSchema();
const INPUT_FIELDS = TURN_SCHEMA.legacy_input_field_order.split("|");
const FINDING_FIELDS = TURN_SCHEMA.legacy_record_field_order.findings.split("|");
const QUESTION_FIELDS = TURN_SCHEMA.legacy_record_field_order.question.split("|");

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--project-root", "--index", "--input", "--transcript", "--output", "--now"].includes(arg)) {
      fail(`无法识别参数 ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${arg} 缺少值`);
    const key = arg.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${arg} 只能提供一次`);
    out[key] = value;
    index += 1;
  }
  for (const field of ["project_root", "index", "input", "transcript", "output"]) {
    if (!out[field]) fail(`缺少 --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now 不是合法时间：${out.now}`);
  return { ...out, now };
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 字段必须恰好为：${fields.join(", ")}`);
  }
}

function externalFile(value, label) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg")) throw new Error(`${label} 不得位于 .kg`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} 不存在或不是文件`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} 不得是符号链接`);
  host.canonicalPath(file);
  return file;
}

function outputFile(value) {
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase())) {
    throw new Error("--output 扩展名必须是 .json 或 .yaml");
  }
  if (host.hasPathSegment(file, ".kg")) throw new Error("--output 不得位于 .kg");
  if (fs.existsSync(file)) throw new Error(`拒绝覆盖已有 turn 产物：${file}`);
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("--output 父目录不得是符号链接");
  host.canonicalPath(file);
  return file;
}

function parseJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} 必须是合法 JSON：${error.message}`);
  }
}

function indexMembership(raw, projectRoot) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("--index 必须是对象");
  }
  if (
    raw.kind !== "kg.kickoff_context_index" ||
    raw.version !== 1 ||
    !Array.isArray(raw.entries)
  ) {
    throw new Error("--index kind/version/entries 形状无效");
  }
  if (typeof raw.project_root !== "string" || raw.project_root.trim() === "") {
    throw new Error("--index.project_root 必须是非空字符串");
  }
  const indexRoot = host.canonicalPath(
    path.isAbsolute(raw.project_root) ? raw.project_root : path.resolve(raw.project_root),
  );
  if (indexRoot !== projectRoot) {
    throw new Error("--index 的项目根目录与 --project-root 不一致");
  }
  if (raw.harness !== undefined && !Array.isArray(raw.harness)) {
    throw new Error("--index.harness 必须是数组");
  }

  const membership = new Set();
  for (const [entryIndex, entry] of raw.entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`--index.entries[${entryIndex}] 必须是对象`);
    }
    const sourcePath = nonEmptyString(entry.path, `--index.entries[${entryIndex}].path`);
    let anchor;
    try {
      anchor = documentAnchor.validateStableDocumentReference({
        sourcePath,
        projectRoot,
      });
    } catch (error) {
      throw new Error(
        `--index.entries[${entryIndex}]：${documentAnchor.formatDocumentAnchorErrorZh(error)}`,
      );
    }
    if (membership.has(anchor.sourcePath)) {
      throw new Error(`--index.entries 重复路径 ${anchor.sourcePath}`);
    }
    membership.add(anchor.sourcePath);
  }

  for (const [entryIndex, entry] of (raw.harness ?? []).entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`--index.harness[${entryIndex}] 必须是对象`);
    }
    if (entry.target_path === undefined) continue;
    const sourcePath = nonEmptyString(
      entry.target_path,
      `--index.harness[${entryIndex}].target_path`,
    );
    try {
      const anchor = documentAnchor.validateStableDocumentReference({
        sourcePath,
        projectRoot,
      });
      membership.add(anchor.sourcePath);
    } catch (error) {
      throw new Error(
        `--index.harness[${entryIndex}]：${documentAnchor.formatDocumentAnchorErrorZh(error)}`,
      );
    }
  }
  return membership;
}

function sourceMetadata(file, sourcePath) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) {
    return {
      status: "unregistered",
      authority: sourcePath === "AGENTS.md" ? "project_instruction" : "reference_only",
    };
  }
  let frontmatter;
  try {
    ({ frontmatter } = protocol.splitFrontmatter(text));
  } catch (error) {
    throw new Error(`${sourcePath} frontmatter 无法解析：${error.message}`);
  }
  const status = frontmatter.status ?? frontmatter.lifecycle ?? "unregistered";
  const authority =
    frontmatter.authority ??
    (status === "accepted" ? "formal_decision" : status === "active" ? "project_knowledge" : "reference_only");
  return { status, authority };
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function occurrenceCount(content, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function canonicalRecord(raw, transcriptEnvelope, projectRoot, membership, now) {
  exactFields(raw, INPUT_FIELDS, "turn 输入");
  if (!Array.isArray(raw.findings) || raw.findings.length === 0) {
    throw new Error("findings 必须是非空数组");
  }
  const seenSources = new Set();
  const findings = raw.findings.map((finding, index) => {
    exactFields(finding, FINDING_FIELDS, `findings[${index}]`);
    const sourcePath = nonEmptyString(finding.source_path, `findings[${index}].source_path`);
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(`findings[${index}].line 必须是正整数`);
    }
    let anchor;
    try {
      anchor = documentAnchor.validateStableDocumentReference({
        sourcePath,
        line: finding.line,
        projectRoot,
      });
    } catch (error) {
      throw new Error(
        `findings[${index}]：${documentAnchor.formatDocumentAnchorErrorZh(error)}`,
      );
    }
    if (!membership.has(anchor.sourcePath)) {
      throw new Error(`findings[${index}].source_path 未出现在 kickoff index：${anchor.sourcePath}`);
    }
    if (seenSources.has(anchor.sourcePath)) {
      throw new Error(`findings 不得重复 source_path：${anchor.sourcePath}`);
    }
    seenSources.add(anchor.sourcePath);
    const expected = sourceMetadata(anchor.full, anchor.sourcePath);
    if (finding.status !== expected.status) {
      throw new Error(
        `findings[${index}].status 应为 ${expected.status}，实际为 ${finding.status}`,
      );
    }
    if (finding.authority !== expected.authority) {
      throw new Error(
        `findings[${index}].authority 应为 ${expected.authority}，实际为 ${finding.authority}`,
      );
    }
    return {
      source_path: anchor.sourcePath,
      line: finding.line,
      status: finding.status,
      authority: finding.authority,
    };
  });

  exactFields(raw.question, QUESTION_FIELDS, "question");
  const questionText = nonEmptyString(raw.question.question_text, "question.question_text");
  const messageIndex = raw.question.assistant_message_index;
  if (!Number.isInteger(messageIndex) || messageIndex < 0) {
    throw new Error("question.assistant_message_index 必须是非负整数");
  }
  const messages = Array.isArray(transcriptEnvelope)
    ? transcriptEnvelope
    : transcriptEnvelope?.transcript;
  if (!Array.isArray(messages)) throw new Error("transcript JSON 必须包含 transcript 数组");
  const message = messages[messageIndex];
  if (!message || message.role !== "assistant" || typeof message.content !== "string") {
    throw new Error("question.assistant_message_index 必须指向实际 assistant 消息");
  }
  const occurrences = occurrenceCount(message.content, questionText);
  if (occurrences !== 1) {
    throw new Error(`question.question_text 必须在指定 assistant 消息中恰好出现一次，实际 ${occurrences} 次`);
  }

  return machineContract.orderRecordByProtocol({
    kind: "kg.kickoff_turn",
    version: 1,
    recorded_at: now.toISOString(),
    session_id: crypto.randomUUID(),
    findings,
    question: {
      question_text: questionText,
      assistant_message_index: messageIndex,
    },
  }, TURN_SCHEMA.legacy_field_order, TURN_SCHEMA.legacy_record_field_order);
}

function writeRecord(file, record) {
  const content = path.extname(file).toLowerCase() === ".json"
    ? `${JSON.stringify(record, null, 2)}\n`
    : kyaml.stringify(record);
  fs.writeFileSync(file, content, { flag: "wx" });
}

function mainLegacy(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const projectRoot = host.assertSafeHostRoot(args.project_root);
    const index = externalFile(args.index, "--index");
    const input = externalFile(args.input, "--input");
    const transcript = externalFile(args.transcript, "--transcript");
    const output = outputFile(args.output);
    const membership = indexMembership(parseJson(index, "--index"), projectRoot);
    const raw = parseJson(input, "--input");
    const transcriptEnvelope = parseJson(transcript, "--transcript");
    const record = canonicalRecord(raw, transcriptEnvelope, projectRoot, membership, args.now);
    writeRecord(output, record);
    console.log(`kg: kickoff turn 已写入 ${output}，共 ${record.findings.length} 条 finding`);
  } catch (error) {
    fail(`turn 记录校验失败：${error.message}`);
  }
}

function parseV2Args(argv) {
  const out = {};
  const allowed = new Set([
    "--project-root", "--index", "--scope", "--deep", "--session", "--input", "--transcript", "--output", "--now",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) throw new Error(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  for (const field of ["project_root", "index", "scope", "deep", "session", "input", "transcript", "output"]) {
    if (!out[field]) throw new Error(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function v2Messages(raw) {
  const messages = Array.isArray(raw) ? raw : raw?.transcript;
  if (!Array.isArray(messages)) throw new Error("transcript must be a list or contain a transcript list");
  for (const [index, message] of messages.entries()) {
    if (message === null || typeof message !== "object" || Array.isArray(message) ||
        !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error(`transcript[${index}] is invalid`);
    }
  }
  return messages;
}

function validatedProduct(file, schema, label) {
  const text = fs.readFileSync(file, "utf8");
  let value;
  try {
    value = path.extname(file).toLowerCase() === ".json" || text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : kyaml.parse(text);
  } catch (error) {
    throw new Error(`${label} must be a machine record: ${error.message}`);
  }
  const errors = protocol.validateRecord(value, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid: ${errors.join("; ")}`);
  return value;
}

function questionMarks(value) {
  return [...String(value)].filter((character) => character === "?" || character === "？").length;
}

function renderAssistantMessage(question) {
  const optionLines = question.options.map((option, index) => `${index + 1}. ${option}`);
  return [
    question.question_text,
    "",
    "选项：",
    ...optionLines,
    "",
    `推荐：${question.recommendation}`,
    `依据：${question.reason_refs.join("，")}`,
  ].join("\n");
}

function mainV2(argv) {
  const args = parseV2Args(argv);
  const projectRoot = host.assertSafeHostRoot(args.project_root);
  const indexFile = externalFile(args.index, "--index");
  const scopeFile = externalFile(args.scope, "--scope");
  const deepFile = externalFile(args.deep, "--deep");
  const sessionFile = externalFile(args.session, "--session");
  const inputFile = externalFile(args.input, "--input");
  const transcriptFile = externalFile(args.transcript, "--transcript");
  const output = outputFile(args.output);
  const indexSchema = protocol.loadKickoffIndexSchema();
  const scopeSchema = protocol.loadKickoffScopeSchema();
  const deepSchema = protocol.loadKickoffDeepSchema();
  const sessionSchema = protocol.loadKickoffSessionSchema();
  const turnSchema = protocol.loadKickoffTurnSchema();
  const index = validatedProduct(indexFile, indexSchema, "index");
  const scope = validatedProduct(scopeFile, scopeSchema, "scope");
  const deep = validatedProduct(deepFile, deepSchema, "deep");
  const session = validatedProduct(sessionFile, sessionSchema, "session");
  const raw = parseJson(inputFile, "--input");
  const messages = v2Messages(parseJson(transcriptFile, "--transcript"));
  machineContract.assertRawInput(raw, turnSchema, "kickoff turn");
  if (host.canonicalPath(index.project_root) !== projectRoot || deep.project_root !== projectRoot) {
    throw new Error("index or deep product belongs to a different project root");
  }
  const indexSha256 = machineContract.sha256File(indexFile);
  const scopeSha256 = machineContract.sha256File(scopeFile);
  if (scope.index_sha256 !== indexSha256 || deep.index_sha256 !== indexSha256 || deep.scope_sha256 !== scopeSha256) {
    throw new Error("index, scope, and deep products are not one bound chain");
  }
  if (session.status !== "active" || session.task_sha256 !== index.task_sha256 || host.canonicalPath(session.index_ref) !== host.canonicalPath(indexFile)) {
    throw new Error("session is inactive or bound to a different index");
  }
  const userMessage = messages[raw.user_message_index];
  if (!userMessage || userMessage.role !== "user") throw new Error("user_message_index must point to a user message");
  const deepByPath = new Map(deep.documents.map((document) => [document.path, document]));
  const findings = raw.findings.map((finding, indexValue) => {
    const document = deepByPath.get(finding.source_path);
    if (!document) throw new Error(`findings[${indexValue}] is outside the deep exact set`);
    let anchor;
    try {
      anchor = documentAnchor.validateStableDocumentReference({
        sourcePath: finding.source_path,
        line: finding.line,
        projectRoot,
      });
    } catch (error) {
      throw new Error(`findings[${indexValue}]: ${documentAnchor.formatDocumentAnchorErrorZh(error)}`);
    }
    if (finding.status !== document.status || finding.authority !== document.authority) {
      throw new Error(`findings[${indexValue}] status or authority differs from deep metadata`);
    }
    const seed = machineContract.sha256CanonicalJson({
      session_id: session.session_id,
      sequence: session.next_turn_sequence,
      path: anchor.sourcePath,
      line: anchor.line,
    });
    return {
      finding_id: `KF-${seed.slice(-12).toUpperCase()}`,
      source_path: anchor.sourcePath,
      line: anchor.line,
      status: finding.status,
      authority: finding.authority,
    };
  });
  if (new Set(findings.map((finding) => finding.finding_id)).size !== findings.length) {
    throw new Error("findings contain duplicate source anchors");
  }
  if (questionMarks(raw.question.question_text) !== 1 || raw.question.options.some((option) => questionMarks(option) > 0)) {
    throw new Error("question_text must contain exactly one question mark and options must contain none");
  }
  if (new Set(raw.question.options).size !== raw.question.options.length || !raw.question.options.includes(raw.question.recommendation)) {
    throw new Error("question options must be unique and include the recommendation");
  }
  const findingRefs = new Set(findings.map((finding) => `${finding.source_path}#L${finding.line}`));
  if (raw.question.reason_refs.some((ref) => !findingRefs.has(ref))) {
    throw new Error("every question reason_ref must name a finding anchor from this turn");
  }
  const assistantMessage = renderAssistantMessage(raw.question);
  if (questionMarks(assistantMessage) !== 1) throw new Error("rendered assistant message must contain one question");
  const assistant = messages[raw.question.assistant_message_index];
  if (!assistant || assistant.role !== "assistant" || assistant.content !== assistantMessage) {
    throw new Error("assistant transcript message is not byte-identical to the script-rendered question");
  }
  const suffix = session.session_id.slice("KSESSION-".length);
  const sequence = session.next_turn_sequence;
  const question = {
    ...raw.question,
    assistant_message: assistantMessage,
    assistant_message_sha256: machineContract.sha256Bytes(assistantMessage),
  };
  const record = machineContract.buildCanonicalRecord(
    raw,
    {
      kind: turnSchema.product_kind,
      version: turnSchema.product_version,
      recorded_at: args.now.toISOString(),
      session_id: session.session_id,
      turn_id: `KTURN-${suffix}-${String(sequence).padStart(3, "0")}`,
      sequence,
      user_message_sha256: machineContract.sha256Bytes(userMessage.content),
      findings,
      question,
    },
    turnSchema,
    "kickoff turn",
  );
  machineContract.writeCanonicalRecord(output, record, turnSchema, { label: "kickoff turn" });
  console.log(`kg: wrote turn ${record.turn_id} with one script-rendered question`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes("--session")) mainV2(argv);
    else mainLegacy(argv);
  } catch (error) {
    fail(`turn 记录校验失败：${error.message}`);
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
