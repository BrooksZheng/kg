// Validate agent-authored JSON and write a canonical machine-readable kickoff
// conflict product. Runtime requirements: Node.js >= 18 and no dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, host, kyaml, machineContract, protocol } from "./_lib.mjs";

const CONFLICT_SCHEMA = protocol.loadKickoffConflictSchema();
const RECORD_FIELDS = CONFLICT_SCHEMA.legacy_field_order.split("|");
const CONFLICT_FIELDS = CONFLICT_SCHEMA.legacy_record_field_order.conflicts.split("|");

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

function requireRoot(value) {
  if (!value) fail("缺少 --project-root");
  const root = path.resolve(value);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`项目根目录不存在：${root}`);
  if (fs.lstatSync(root).isSymbolicLink()) fail(`项目根目录不能是符号链接：${root}`);
  return fs.realpathSync(root);
}

function requireInput(value) {
  if (!value) fail("缺少 --input");
  const file = path.resolve(value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`--input 文件不存在：${file}`);
  if (fs.lstatSync(file).isSymbolicLink()) fail(`--input 不能是符号链接：${file}`);
  return file;
}

function requireOutput(value) {
  if (!value) fail("缺少 --output");
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase())) {
    fail("--output 扩展名必须是 .json 或 .yaml");
  }
  return file;
}

function rejectUnknown(record, allowed, label) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} 必须是对象`);
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} 含未知字段：${unknown.join(", ")}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
  return value.trim();
}

function canonicalRecord(raw, projectRoot) {
  rejectUnknown(raw, RECORD_FIELDS, "冲突记录");
  if (raw.kind !== "kg.kickoff_conflicts") throw new Error("kind 必须是 kg.kickoff_conflicts");
  if (raw.version !== 1) throw new Error("version 必须是 1");
  if (!Object.prototype.hasOwnProperty.call(raw, "conflicts") || !Array.isArray(raw.conflicts)) {
    throw new Error("conflicts 字段必须存在且为数组");
  }

  const conflicts = raw.conflicts.map((item, index) => {
    rejectUnknown(item, CONFLICT_FIELDS, `conflicts[${index}]`);
    const summary = requireString(item.summary, `conflicts[${index}].summary`);
    requireString(item.source_path, `conflicts[${index}].source_path`);
    if (!Object.prototype.hasOwnProperty.call(item, "line") || !Number.isInteger(item.line) || item.line < 1) {
      throw new Error(`conflicts[${index}].line 必须是正整数`);
    }
    let validated;
    try {
      validated = documentAnchor.validateStableDocumentReference({
        sourcePath: item.source_path,
        line: item.line,
        projectRoot,
      });
    } catch (error) {
      throw new Error(`conflicts[${index}]：${documentAnchor.formatDocumentAnchorErrorZh(error)}`);
    }
    return {
      summary,
      source_path: validated.sourcePath,
      line: validated.line,
    };
  });

  return machineContract.orderRecordByProtocol({
    kind: "kg.kickoff_conflicts",
    version: 1,
    conflicts,
  }, CONFLICT_SCHEMA.legacy_field_order, CONFLICT_SCHEMA.legacy_record_field_order);
}

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = path.extname(file).toLowerCase() === ".json"
    ? `${JSON.stringify(record, null, 2)}\n`
    : kyaml.stringify(record);
  fs.writeFileSync(file, content);
}

function mainLegacy(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectRoot = requireRoot(args.project_root);
  const input = requireInput(args.input);
  const output = requireOutput(args.output);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(input, "utf8"));
  } catch (error) {
    fail(`--input 必须是合法 JSON：${error.message}`);
  }
  let record;
  try {
    record = canonicalRecord(raw, projectRoot);
  } catch (error) {
    fail(`冲突记录校验失败：${error.message}`);
  }
  writeRecord(output, record);
  console.log(`kg: kickoff 冲突记录已写入 ${output}，共 ${record.conflicts.length} 项`);
}

function parseV2Args(argv) {
  const out = {};
  const allowed = new Set(["--project-root", "--session", "--turn", "--deep", "--transcript", "--input", "--output", "--now"]);
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
  for (const field of ["project_root", "session", "turn", "deep", "transcript", "input", "output"]) {
    if (!out[field]) throw new Error(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function readV2Product(value, schema, label) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg") || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`${label} is unsafe or missing`);
  }
  const text = fs.readFileSync(file, "utf8");
  let record;
  try {
    record = path.extname(file).toLowerCase() === ".json" ? JSON.parse(text) : kyaml.parse(text);
  } catch (error) {
    throw new Error(`${label} cannot be parsed: ${error.message}`);
  }
  const errors = protocol.validateRecord(record, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid: ${errors.join("; ")}`);
  return { file: host.canonicalPath(file), record };
}

function v2Messages(value) {
  const file = path.resolve(value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("transcript is unsafe or missing");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const messages = Array.isArray(raw) ? raw : raw?.transcript;
  if (!Array.isArray(messages)) throw new Error("transcript must be a list or contain a transcript list");
  return messages;
}

function mainV2(argv) {
  const args = parseV2Args(argv);
  const projectRoot = host.assertSafeHostRoot(args.project_root);
  const session = readV2Product(args.session, protocol.loadKickoffSessionSchema(), "session").record;
  const turn = readV2Product(args.turn, protocol.loadKickoffTurnSchema(), "turn").record;
  const deep = readV2Product(args.deep, protocol.loadKickoffDeepSchema(), "deep").record;
  const transcript = v2Messages(args.transcript);
  const inputFile = requireInput(args.input);
  const output = requireOutput(args.output);
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite conflict product: ${output}`);
  const raw = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const schema = protocol.loadKickoffConflictSchema();
  machineContract.assertRawInput(raw, schema, "kickoff conflicts");
  if (session.status !== "active" || turn.session_id !== session.session_id || deep.project_root !== projectRoot) {
    throw new Error("session, turn, and deep products are not one active project chain");
  }
  if (raw.assessment === "conflict") {
    if (raw.conflicts.length === 0 || raw.no_conflict_reason_refs.length !== 0) {
      throw new Error("conflict assessment requires conflicts and forbids no_conflict_reason_refs");
    }
  } else if (raw.conflicts.length !== 0 || raw.no_conflict_reason_refs.length === 0) {
    throw new Error("no_conflict assessment requires reason refs and an empty conflicts list");
  }
  const findingById = new Map(turn.findings.map((finding) => [finding.finding_id, finding]));
  const deepPaths = new Set(deep.documents.map((document) => document.path));
  const conflicts = raw.conflicts.map((item, index) => {
    const taskMessage = transcript[item.task_message_index];
    if (!taskMessage || taskMessage.role !== "user" || typeof taskMessage.content !== "string") {
      throw new Error(`conflicts[${index}].task_message_index must point to a user message`);
    }
    const finding = findingById.get(item.finding_id);
    if (!finding) throw new Error(`conflicts[${index}].finding_id is absent from the turn`);
    if (finding.source_path !== item.constraint_source_path || finding.line !== item.constraint_line) {
      throw new Error(`conflicts[${index}] constraint anchor differs from its finding`);
    }
    if (!deepPaths.has(item.constraint_source_path)) throw new Error(`conflicts[${index}] constraint is outside the deep exact set`);
    const anchor = documentAnchor.validateStableDocumentReference({
      sourcePath: item.constraint_source_path,
      line: item.constraint_line,
      projectRoot,
    });
    const seed = machineContract.sha256CanonicalJson({
      session_id: session.session_id,
      task_message_index: item.task_message_index,
      constraint: `${anchor.sourcePath}#L${anchor.line}`,
    });
    return {
      conflict_id: `KC-${seed.slice(-12).toUpperCase()}`,
      summary: item.summary,
      task_message_index: item.task_message_index,
      task_message_sha256: machineContract.sha256Bytes(taskMessage.content),
      constraint_source_path: anchor.sourcePath,
      constraint_line: anchor.line,
      constraint_sha256: machineContract.sha256File(anchor.full),
      finding_id: item.finding_id,
    };
  });
  const validReasonRefs = new Set(turn.findings.map((finding) => `${finding.source_path}#L${finding.line}`));
  if (raw.no_conflict_reason_refs.some((ref) => !validReasonRefs.has(ref))) {
    throw new Error("no_conflict_reason_refs must name findings from the turn");
  }
  const record = machineContract.buildCanonicalRecord(
    raw,
    {
      kind: schema.product_kind,
      version: schema.product_version,
      recorded_at: args.now.toISOString(),
      session_id: session.session_id,
      conflicts,
    },
    schema,
    "kickoff conflicts",
  );
  machineContract.writeCanonicalRecord(output, record, schema, { label: "kickoff conflicts" });
  console.log(`kg: wrote ${record.assessment} conflict product with ${record.conflicts.length} conflict(s)`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes("--session")) mainV2(argv);
    else mainLegacy(argv);
  } catch (error) {
    fail(`冲突记录校验失败：${error.message}`);
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
