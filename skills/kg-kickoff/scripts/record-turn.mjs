// Validate agent-authored kickoff semantics against a transcript snapshot and
// write the canonical kg.kickoff_turn product. Script-owned envelope fields
// never appear in the agent JSON input.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, host, kyaml, protocol } from "./_lib.mjs";

const INPUT_FIELDS = ["findings", "question"];
const FINDING_FIELDS = ["source_path", "line", "status", "authority"];
const QUESTION_FIELDS = ["question_text", "assistant_message_index"];

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

  return {
    kind: "kg.kickoff_turn",
    version: 1,
    recorded_at: now.toISOString(),
    session_id: crypto.randomUUID(),
    findings,
    question: {
      question_text: questionText,
      assistant_message_index: messageIndex,
    },
  };
}

function writeRecord(file, record) {
  const content = path.extname(file).toLowerCase() === ".json"
    ? `${JSON.stringify(record, null, 2)}\n`
    : kyaml.stringify(record);
  fs.writeFileSync(file, content, { flag: "wx" });
}

export function main(argv = process.argv.slice(2)) {
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

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) main();
