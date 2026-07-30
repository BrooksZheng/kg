// Validate agent-authored JSON and write a canonical machine-readable kickoff
// conflict product. Runtime requirements: Node.js >= 18 and no dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, kyaml } from "./_lib.mjs";

const RECORD_FIELDS = ["kind", "version", "conflicts"];
const CONFLICT_FIELDS = ["summary", "source_path", "line"];

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

  return {
    kind: "kg.kickoff_conflicts",
    version: 1,
    conflicts,
  };
}

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = path.extname(file).toLowerCase() === ".json"
    ? `${JSON.stringify(record, null, 2)}\n`
    : kyaml.stringify(record);
  fs.writeFileSync(file, content);
}

export function main(argv = process.argv.slice(2)) {
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

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) main();
