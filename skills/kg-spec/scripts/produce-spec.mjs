// Deterministic packet preparation, rendering, and validation for task specs.
// Semantic synthesis belongs to the kg-spec agent. This script accepts a
// strict structured synthesis and never asks the user for more information.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, host, kyaml, protocol } from "./_lib.mjs";

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
const ARCHIVE_TASK_FIELDS = ["title"];
const CONSTRAINT_FIELDS = ["constraint", "source_path", "source_status", "authority"];
const OUT_OF_SCOPE_FIELDS = ["statement", "conflict_source_path"];
const SESSION_HISTORY_FIELDS = ["session_id", "turn_session_id", "product_kinds"];
const KICKOFF_PRODUCT_KINDS = [
  "kg.kickoff_context_index",
  "kg.kickoff_context",
  "kg.kickoff_turn",
  "kg.kickoff_conflicts",
];

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prepare" || arg === "--finalize" || arg === "--archive") {
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
  if (!out.mode) fail("需要 --prepare、--finalize、--archive 或 --check");
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
  try {
    return host.assertSafeHostRoot(value);
  } catch (error) {
    fail(error.message);
  }
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

function canonicalLegacySynthesis(raw) {
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

function exactStringSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (actual.length !== left.length || JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} must be exactly: ${right.join(", ")}`);
  }
}

function readMachineProduct(product) {
  const content = product.content;
  if (typeof content !== "string") throw new Error(`${product.kind} product content is missing`);
  try {
    return product.path.endsWith(".json") || content.trimStart().startsWith("{")
      ? JSON.parse(content)
      : kyaml.parse(content);
  } catch (error) {
    throw new Error(`${product.kind} product is invalid: ${error.message}`);
  }
}

function productByKind(packet, kind, { required = true } = {}) {
  const matches = packet.intermediate_products.filter((product) => product.kind === kind);
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) throw new Error(`packet must contain exactly one ${kind} product`);
  return matches[0];
}

function sourceMetadata(file, sourcePath) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) {
    return {
      status: "unregistered",
      authority: sourcePath === "AGENTS.md" ? "project_instruction" : "reference_only",
    };
  }
  const { frontmatter } = protocol.splitFrontmatter(text);
  const status = frontmatter.status ?? frontmatter.lifecycle ?? "unregistered";
  const authority =
    frontmatter.authority ??
    (status === "accepted" ? "formal_decision" : status === "active" ? "project_knowledge" : "reference_only");
  return { status, authority };
}

function canonicalArchiveSynthesis(raw, packet, root) {
  rejectUnknown(raw, SYNTHESIS_FIELDS, "synthesis");
  if (raw.kind !== "kg.spec_synthesis") throw new Error("synthesis.kind must be kg.spec_synthesis");
  if (raw.version !== 2) throw new Error("archive synthesis.version must be 2");
  rejectUnknown(raw.task, ARCHIVE_TASK_FIELDS, "synthesis.task");

  const turn = readMachineProduct(productByKind(packet, "kg.kickoff_turn"));
  if (
    turn.kind !== "kg.kickoff_turn" ||
    turn.version !== 1 ||
    typeof turn.session_id !== "string" ||
    !Array.isArray(turn.findings) ||
    turn.findings.length === 0
  ) {
    throw new Error("packet kg.kickoff_turn shape is invalid");
  }
  const findingByAnchor = new Map();
  for (const finding of turn.findings) {
    const key = `${finding.source_path}#L${finding.line}`;
    if (findingByAnchor.has(key)) throw new Error(`packet kickoff finding is duplicated: ${key}`);
    findingByAnchor.set(key, finding);
  }

  if (!Array.isArray(raw.constraints) || raw.constraints.length === 0) {
    throw new Error("synthesis.constraints must be a non-empty list");
  }
  const constraints = raw.constraints.map((item, index) => {
    rejectUnknown(item, CONSTRAINT_FIELDS, `synthesis.constraints[${index}]`);
    const sourcePath = requireString(item.source_path, `synthesis.constraints[${index}].source_path`);
    documentAnchor.validateConstraintAnchor(
      sourcePath,
      root,
      protocol.loadTaskSpecSchema().constraint_source_path_pattern,
    );
    const finding = findingByAnchor.get(sourcePath);
    if (!finding) throw new Error(`constraint source is absent from kickoff findings: ${sourcePath}`);
    const sourceFile = path.resolve(root, ...finding.source_path.split("/"));
    const metadata = sourceMetadata(sourceFile, finding.source_path);
    const sourceStatus = requireString(item.source_status, `synthesis.constraints[${index}].source_status`);
    const authority = requireString(item.authority, `synthesis.constraints[${index}].authority`);
    if (
      sourceStatus !== finding.status ||
      authority !== finding.authority ||
      sourceStatus !== metadata.status ||
      authority !== metadata.authority
    ) {
      throw new Error(`constraint source metadata does not match kickoff index semantics: ${sourcePath}`);
    }
    return {
      constraint: requireString(item.constraint, `synthesis.constraints[${index}].constraint`),
      source_path: sourcePath,
      source_status: sourceStatus,
      authority,
    };
  });
  exactStringSet(
    constraints.map((item) => item.source_path),
    [...findingByAnchor.keys()],
    "constraint source set",
  );

  if (!Array.isArray(raw.out_of_scope) || raw.out_of_scope.length === 0) {
    throw new Error("synthesis.out_of_scope must be a non-empty list");
  }
  const outOfScope = raw.out_of_scope.map((item, index) => {
    rejectUnknown(item, OUT_OF_SCOPE_FIELDS, `synthesis.out_of_scope[${index}]`);
    const conflictSource =
      item.conflict_source_path === null
        ? null
        : requireString(item.conflict_source_path, `synthesis.out_of_scope[${index}].conflict_source_path`);
    return {
      statement: requireString(item.statement, `synthesis.out_of_scope[${index}].statement`),
      conflict_source_path: conflictSource,
    };
  });
  const conflictProduct = productByKind(packet, "kg.kickoff_conflicts", { required: false });
  const conflicts = conflictProduct ? readMachineProduct(conflictProduct).conflicts : [];
  if (!Array.isArray(conflicts)) throw new Error("packet kg.kickoff_conflicts shape is invalid");
  exactStringSet(
    outOfScope.map((item) => item.conflict_source_path).filter(Boolean),
    conflicts.map((item) => item.source_path),
    "Out of Scope conflict source set",
  );

  if (!Array.isArray(raw.session_history) || raw.session_history.length === 0) {
    throw new Error("synthesis.session_history must be a non-empty list");
  }
  const sessionHistory = raw.session_history.map((item, index) => {
    rejectUnknown(item, SESSION_HISTORY_FIELDS, `synthesis.session_history[${index}]`);
    return {
      session_id: requireString(item.session_id, `synthesis.session_history[${index}].session_id`),
      turn_session_id: requireString(item.turn_session_id, `synthesis.session_history[${index}].turn_session_id`),
      product_kinds: stringList(item.product_kinds, `synthesis.session_history[${index}].product_kinds`),
    };
  });
  const productKinds = packet.intermediate_products.map((product) => product.kind);
  const matchingHistory = sessionHistory.filter(
    (item) => item.session_id === packet.session_id && item.turn_session_id === turn.session_id,
  );
  if (matchingHistory.length !== 1) {
    throw new Error("Session History must bind the kickoff runner session and kg.kickoff_turn session exactly once");
  }
  exactStringSet(matchingHistory[0].product_kinds, productKinds, "Session History product_kinds");

  const index = readMachineProduct(productByKind(packet, "kg.kickoff_context_index"));
  if (Array.isArray(index.harness) && index.harness.length > 0) {
    const activeKn = constraints.some(
      (item) => item.source_path.startsWith("knowledge/") && item.source_status === "active",
    );
    const carrierTargets = new Set(index.harness.map((item) => item.target_path));
    const managedDocument = constraints.some((item) => {
      const sourcePath = item.source_path.replace(/#L[1-9][0-9]*$/, "");
      return carrierTargets.has(sourcePath);
    });
    if (!activeKn || !managedDocument) {
      throw new Error("compiled kickoff synthesis must constrain both an active KN and its managed document");
    }
  }

  return {
    kind: "kg.spec_synthesis",
    version: 2,
    task: {
      title: requireString(raw.task.title, "synthesis.task.title"),
    },
    context: stringList(raw.context, "synthesis.context"),
    requirements: stringList(raw.requirements, "synthesis.requirements"),
    constraints,
    references: stringList(raw.references, "synthesis.references"),
    out_of_scope: outOfScope.map((item) => item.statement),
    acceptance_criteria: stringList(raw.acceptance_criteria, "synthesis.acceptance_criteria"),
    open_questions: stringList(raw.open_questions, "synthesis.open_questions", { allowEmpty: true }),
    session_history: sessionHistory.map(
      (item) =>
        `kickoff session ${item.session_id}; turn session ${item.turn_session_id}; products ${item.product_kinds.join(", ")}`,
    ),
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

export function renderSpec(synthesis, envelope = {}) {
  const frontmatter = {
    kind: "kg.task_spec",
    task_id: envelope.taskId ?? synthesis.task.task_id,
    created_at: envelope.createdAt ?? new Date().toISOString(),
    status: envelope.status ?? synthesis.task.status,
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
      const match = /^(.*)#L[1-9][0-9]*$/.exec(cells[1]);
      const sourceFile = path.resolve(root, ...match[1].split("/"));
      const metadata = sourceMetadata(sourceFile, match[1]);
      if (cells[2] !== metadata.status || cells[3] !== metadata.authority) {
        errors.push(`constraint source metadata mismatch for ${cells[1]}`);
      }
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
  let intermediateProducts = Array.isArray(raw) ? [] : raw.intermediate_products ?? [];
  if (args.kickoff_artifacts) {
    const artifactsRoot = requireRoot(args.kickoff_artifacts);
    intermediateProducts = [];
    for (const kind of KICKOFF_PRODUCT_KINDS) {
      const matches = (raw.products ?? []).filter((product) => product?.kind === kind);
      if (matches.length === 0 && kind === "kg.kickoff_conflicts") continue;
      if (matches.length !== 1) fail(`Runner Contract 必须恰好登记一个 ${kind} 产物`);
      const declared = matches[0].path;
      if (typeof declared !== "string" || declared.trim() === "") fail(`${kind} product path 无效`);
      const portable = declared.replaceAll("\\", "/");
      const relative = path.isAbsolute(portable) ? path.basename(portable) : portable;
      let resolved;
      try {
        resolved = host.resolveSafeRelative(artifactsRoot, relative);
      } catch (error) {
        fail(`${kind} product path 无效：${error.message}`);
      }
      if (!fs.statSync(resolved.full).isFile()) fail(`${kind} product 不是文件`);
      intermediateProducts.push({
        kind,
        path: resolved.relative,
        content: fs.readFileSync(resolved.full, "utf8"),
      });
    }
  }
  const packet = {
    kind: "kg.spec_synthesis_packet",
    version: args.kickoff_artifacts ? 2 : 1,
    readonly: true,
    project_root: root,
    source_transcript: transcriptFile,
    session_id: Array.isArray(raw) ? null : raw.session_id ?? null,
    transcript: messages,
    file_reads: Array.isArray(raw) ? [] : raw.file_reads ?? [],
    citations: Array.isArray(raw) ? [] : raw.citations ?? [],
    products: Array.isArray(raw) ? [] : raw.products ?? [],
    tool_events: Array.isArray(raw) ? [] : raw.tool_events ?? [],
    permission_denials: Array.isArray(raw) ? [] : raw.permission_denials ?? [],
    context_index: Array.isArray(raw) ? null : raw.context_index ?? null,
    gathered_context: Array.isArray(raw) ? null : raw.gathered_context ?? null,
    intermediate_products: intermediateProducts,
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
  if (host.canonicalPath(packet.project_root) !== root) {
    fail("--packet 的项目根目录与 --project-root 不一致");
  }
  let synthesis;
  try {
    const raw = parseSynthesis(synthesisFile, fs.readFileSync(synthesisFile, "utf8"));
    synthesis = canonicalLegacySynthesis(raw);
  } catch (error) {
    fail(`synthesis 校验失败：${error.message}`);
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now 无效：${args.now}`);
  const rendered = renderSpec(synthesis, { createdAt: now.toISOString() });
  const errors = validateSpecText(rendered, root);
  if (errors.length) fail(`task spec 校验失败：\n  ${errors.join("\n  ")}`);
  const output = writeFile(args.output, rendered);
  console.log(`kg: task spec 已写入 ${output}，八个章节与文档锚点校验通过`);
}

function nextTaskArchive(root, now) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const specs = host.resolveSafeRelative(root, "docs/specs", { mustExist: false });
  fs.mkdirSync(specs.full, { recursive: true });
  const pattern = new RegExp(`^TASK-${day}-([0-9]{3})\\.md$`);
  let max = 0;
  for (const entry of fs.readdirSync(specs.full, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  if (max >= 999) throw new Error(`task id space exhausted for ${day}`);
  const taskId = `TASK-${day}-${String(max + 1).padStart(3, "0")}`;
  return {
    taskId,
    file: host.resolveSafeRelative(root, `docs/specs/${taskId}.md`, { mustExist: false }).full,
  };
}

function runArchive(args) {
  const root = requireRoot(args.project_root);
  const packetFile = requireFile(args.packet, "--packet");
  const synthesisFile = requireFile(args.synthesis, "--synthesis");
  const packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
  if (
    packet.kind !== "kg.spec_synthesis_packet" ||
    packet.version !== 2 ||
    packet.readonly !== true ||
    !Array.isArray(packet.intermediate_products)
  ) {
    fail("--packet 不是 v2 只读 synthesis packet");
  }
  if (host.canonicalPath(packet.project_root) !== root) {
    fail("--packet 的项目根目录与 --project-root 不一致");
  }
  let synthesis;
  try {
    const content = fs.readFileSync(synthesisFile, "utf8");
    if (!content.trimStart().startsWith("{")) {
      throw new Error("archive synthesis must be JSON");
    }
    const raw = JSON.parse(content);
    synthesis = canonicalArchiveSynthesis(raw, packet, root);
  } catch (error) {
    fail(`archive synthesis 校验失败：${error.message}`);
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now 无效：${args.now}`);
  let archive;
  try {
    archive = nextTaskArchive(root, now);
  } catch (error) {
    fail(error.message);
  }
  const rendered = renderSpec(synthesis, {
    taskId: archive.taskId,
    createdAt: now.toISOString(),
    status: "draft",
  });
  const errors = validateSpecText(rendered, root);
  if (errors.length) fail(`task spec 校验失败：\n  ${errors.join("\n  ")}`);
  try {
    fs.writeFileSync(archive.file, rendered, { flag: "wx" });
  } catch (error) {
    fail(error.code === "EEXIST" ? `拒绝覆盖已有 archive：${archive.file}` : error.message);
  }
  console.log(JSON.stringify({
    kind: "kg.spec_archive_result",
    version: 1,
    task_id: archive.taskId,
    created_at: now.toISOString(),
    status: "draft",
    path: path.relative(root, archive.file).split(path.sep).join("/"),
  }));
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
  const specsRoot = host.resolveSafeRelative(root, "docs/specs", { mustExist: false }).canonical;
  const canonicalSpec = host.canonicalPath(specFile);
  if (!host.isOutside(specsRoot, canonicalSpec)) {
    const { frontmatter } = protocol.splitFrontmatter(fs.readFileSync(specFile, "utf8"));
    if (frontmatter.status !== "draft") fail("归档 task spec 的初始状态必须为 draft");
    if (path.basename(specFile) !== `${frontmatter.task_id}.md`) {
      fail("归档 task spec 文件名必须与 task_id 一致");
    }
  }
  console.log(`kg: task spec 校验通过：${specFile}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.mode === "prepare") runPrepare(args);
  else if (args.mode === "finalize") runFinalize(args);
  else if (args.mode === "archive") runArchive(args);
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
