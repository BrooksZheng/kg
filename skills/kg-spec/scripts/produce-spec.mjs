// Deterministic packet preparation, rendering, and validation for task specs.
// Semantic synthesis belongs to the kg-spec agent. This script accepts a
// strict structured synthesis and never asks the user for more information.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, kyaml, protocol } from "./_lib.mjs";

const SYNTHESIS_FIELDS = [
  "kind",
  "version",
  "task",
  "context",
  "requirements",
  "constraints",
  "references",
  "out_of_scope",
  "acceptance_criteria",
  "open_questions",
  "session_history",
];
const TASK_FIELDS = ["task_id", "status", "title"];
const CONSTRAINT_FIELDS = ["constraint", "source_path", "source_status", "authority"];

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prepare" || arg === "--finalize") {
      if (out.mode) fail("只能选择一个模式");
      out.mode = arg.slice(2);
      continue;
    }
    if (arg === "--check") {
      if (out.mode) fail("只能选择一个模式");
      out.mode = "check";
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail("--check 缺少 spec 文件");
      out.spec = value;
      i += 1;
      continue;
    }
    if (!arg.startsWith("--")) fail(`无法识别参数 ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} 缺少值`);
    out[arg.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  if (!out.mode) fail("需要 --prepare、--finalize 或 --check");
  return out;
}

function requireFile(value, flag) {
  if (!value) fail(`缺少 ${flag}`);
  const file = path.resolve(value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${flag} 文件不存在：${file}`);
  return file;
}

function requireRoot(value) {
  if (!value) fail("缺少 --project-root");
  const root = path.resolve(value);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`项目根目录不存在：${root}`);
  if (fs.lstatSync(root).isSymbolicLink()) fail(`项目根目录不能是符号链接：${root}`);
  return fs.realpathSync(root);
}

function parseSynthesis(file, content) {
  if (path.extname(file) === ".json" || content.trimStart().startsWith("{")) {
    return JSON.parse(content);
  }
  return kyaml.parse(content);
}

function writeFile(output, content) {
  if (!output) fail("缺少 --output");
  const file = path.resolve(output);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function rejectUnknown(record, allowed, label) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} must be a mapping`);
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
    throw new Error(`${label} must be a list of non-empty strings`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  return value.map((item) => item.trim());
}

function canonicalSynthesis(raw) {
  rejectUnknown(raw, SYNTHESIS_FIELDS, "synthesis");
  if (raw.kind !== "kg.spec_synthesis") throw new Error("synthesis.kind must be kg.spec_synthesis");
  if (raw.version !== 1) throw new Error("synthesis.version must be 1");
  rejectUnknown(raw.task, TASK_FIELDS, "synthesis.task");
  const constraintsRaw = raw.constraints;
  if (!Array.isArray(constraintsRaw) || constraintsRaw.length === 0) {
    throw new Error("synthesis.constraints must be a non-empty list");
  }
  const constraints = constraintsRaw.map((item, index) => {
    rejectUnknown(item, CONSTRAINT_FIELDS, `synthesis.constraints[${index}]`);
    return {
      constraint: requireString(item.constraint, `synthesis.constraints[${index}].constraint`),
      source_path: requireString(item.source_path, `synthesis.constraints[${index}].source_path`),
      source_status: requireString(item.source_status, `synthesis.constraints[${index}].source_status`),
      authority: requireString(item.authority, `synthesis.constraints[${index}].authority`),
    };
  });
  return {
    kind: "kg.spec_synthesis",
    version: 1,
    task: {
      task_id: requireString(raw.task.task_id, "synthesis.task.task_id"),
      status: requireString(raw.task.status, "synthesis.task.status"),
      title: requireString(raw.task.title, "synthesis.task.title"),
    },
    context: stringList(raw.context, "synthesis.context"),
    requirements: stringList(raw.requirements, "synthesis.requirements"),
    constraints,
    references: stringList(raw.references, "synthesis.references"),
    out_of_scope: stringList(raw.out_of_scope, "synthesis.out_of_scope"),
    acceptance_criteria: stringList(raw.acceptance_criteria, "synthesis.acceptance_criteria"),
    open_questions: stringList(raw.open_questions, "synthesis.open_questions", { allowEmpty: true }),
    session_history: stringList(raw.session_history, "synthesis.session_history"),
  };
}

function markdownCell(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function bullets(items) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None.";
}

function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function renderSpec(synthesis) {
  const frontmatter = {
    kind: "kg.task_spec",
    task_id: synthesis.task.task_id,
    created_at: new Date().toISOString(),
    status: synthesis.task.status,
  };
  const constraints = synthesis.constraints
    .map(
      (item) =>
        `| ${markdownCell(item.constraint)} | ${markdownCell(item.source_path)} | ${markdownCell(item.source_status)} | ${markdownCell(item.authority)} |`,
    )
    .join("\n");
  return [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${synthesis.task.title}`,
    "",
    "## Context",
    "",
    bullets(synthesis.context),
    "",
    "## Requirements",
    "",
    numbered(synthesis.requirements),
    "",
    "## Constraints",
    "",
    "| Constraint | Source | Source Status | Authority |",
    "| --- | --- | --- | --- |",
    constraints,
    "",
    "## References",
    "",
    bullets(synthesis.references),
    "",
    "## Out of Scope",
    "",
    numbered(synthesis.out_of_scope),
    "",
    "## Acceptance Criteria",
    "",
    numbered(synthesis.acceptance_criteria),
    "",
    "## Open Questions",
    "",
    bullets(synthesis.open_questions),
    "",
    "## Session History",
    "",
    bullets(synthesis.session_history),
    "",
  ].join("\n");
}

function sectionBody(body, section, allSections) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i]) && allSections.includes(lines[i].slice(3).trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function validateSpecText(text, root) {
  const schema = protocol.loadTaskSpecSchema();
  const { frontmatter, body } = protocol.splitFrontmatter(text);
  const errors = protocol.validateRecord(frontmatter, schema);
  const sections = schema.required_sections;
  for (const section of sections) {
    const matches = body.split(/\r?\n/).filter((line) => line.trim() === `## ${section}`).length;
    if (matches !== 1) errors.push(`section \`${section}\` must appear exactly once`);
  }
  const outOfScope = sectionBody(body, "Out of Scope", sections);
  if (!outOfScope || !/^\d+\.\s+\S/m.test(outOfScope)) errors.push("Out of Scope must contain at least one numbered item");
  const acceptance = sectionBody(body, "Acceptance Criteria", sections);
  const acceptanceItems = acceptance?.split(/\r?\n/).filter((line) => /^\d+\.\s+/.test(line)) ?? [];
  if (acceptanceItems.length === 0) {
    errors.push("Acceptance Criteria must contain at least one numbered item");
  } else {
    for (const item of acceptanceItems) {
      if (!/\bGIVEN\b.+\bWHEN\b.+\bTHEN\b/.test(item)) {
        errors.push(`acceptance item must contain GIVEN, WHEN, and THEN: ${item}`);
      }
    }
  }
  const constraints = sectionBody(body, "Constraints", sections);
  const constraintLines = constraints?.split(/\r?\n/) ?? [];
  const expectedHeader = `| ${schema.constraints_columns.join(" | ")} |`;
  if (constraintLines[0] !== expectedHeader) errors.push(`Constraints header must be: ${expectedHeader}`);
  const rows = constraintLines.slice(2).filter((line) => line.startsWith("| "));
  if (rows.length === 0) errors.push("Constraints must contain at least one row");
  for (const row of rows) {
    const cells = row.slice(2, -2).split(" | ");
    if (cells.length !== 4) {
      errors.push(`constraint row must have four columns: ${row}`);
      continue;
    }
    try {
      documentAnchor.validateConstraintAnchor(cells[1], root, schema.constraint_source_path_pattern);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

function runPrepare(args) {
  const root = requireRoot(args.project_root);
  const transcriptFile = requireFile(args.transcript, "--transcript");
  const raw = JSON.parse(fs.readFileSync(transcriptFile, "utf8"));
  const messages = Array.isArray(raw) ? raw : raw.transcript;
  if (!Array.isArray(messages)) fail("transcript 必须是消息数组或含 transcript 数组的对象");
  const packet = {
    kind: "kg.spec_synthesis_packet",
    version: 1,
    readonly: true,
    project_root: root,
    source_transcript: transcriptFile,
    session_id: Array.isArray(raw) ? null : raw.session_id ?? null,
    transcript: messages,
    context_index: Array.isArray(raw) ? null : raw.context_index ?? null,
    gathered_context: Array.isArray(raw) ? null : raw.gathered_context ?? null,
    intermediate_products: Array.isArray(raw) ? [] : raw.intermediate_products ?? [],
  };
  const output = writeFile(args.output, `${JSON.stringify(packet, null, 2)}\n`);
  console.log(`kg: 综合包已写入 ${output}，未发起新问题`);
}

function runFinalize(args) {
  const root = requireRoot(args.project_root);
  const packetFile = requireFile(args.packet, "--packet");
  const synthesisFile = requireFile(args.synthesis, "--synthesis");
  const packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
  if (packet.kind !== "kg.spec_synthesis_packet" || packet.readonly !== true) fail("--packet 不是只读 synthesis packet");
  if (path.resolve(packet.project_root) !== root) fail("--packet 的项目根目录与 --project-root 不一致");
  let synthesis;
  try {
    const raw = parseSynthesis(synthesisFile, fs.readFileSync(synthesisFile, "utf8"));
    synthesis = canonicalSynthesis(raw);
  } catch (error) {
    fail(`synthesis 校验失败：${error.message}`);
  }
  const rendered = renderSpec(synthesis);
  const errors = validateSpecText(rendered, root);
  if (errors.length) fail(`task spec 校验失败：\n  ${errors.join("\n  ")}`);
  const output = writeFile(args.output, rendered);
  console.log(`kg: task spec 已写入 ${output}，八个章节与文档锚点校验通过`);
}

function runCheck(args) {
  const root = requireRoot(args.project_root);
  const specFile = requireFile(args.spec, "--check");
  let errors;
  try {
    errors = validateSpecText(fs.readFileSync(specFile, "utf8"), root);
  } catch (error) {
    errors = [error.message];
  }
  if (errors.length) fail(`task spec 校验失败：\n  ${errors.join("\n  ")}`);
  console.log(`kg: task spec 校验通过：${specFile}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "prepare") runPrepare(args);
  else if (args.mode === "finalize") runFinalize(args);
  else runCheck(args);
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
