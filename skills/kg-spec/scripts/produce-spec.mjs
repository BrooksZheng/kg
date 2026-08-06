// Deterministic packet preparation, rendering, and validation for task specs.
// Semantic synthesis belongs to the kg-spec agent. This script accepts a
// strict structured synthesis and never asks the user for more information.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentAnchor, host, kyaml, machineContract, protocol } from "./_lib.mjs";

const SYNTHESIS_SCHEMA = protocol.loadSpecSynthesisSchema();
const SYNTHESIS_FIELDS = SYNTHESIS_SCHEMA.legacy_field_order.split("|");
const TASK_FIELDS = SYNTHESIS_SCHEMA.legacy_v1_record_field_order.task.split("|");
const ARCHIVE_TASK_FIELDS = SYNTHESIS_SCHEMA.legacy_v2_record_field_order.task.split("|");
const CONSTRAINT_FIELDS = SYNTHESIS_SCHEMA.legacy_v2_record_field_order.constraints.split("|");
const OUT_OF_SCOPE_FIELDS = SYNTHESIS_SCHEMA.legacy_v2_input_record_field_order.out_of_scope.split("|");
const SESSION_HISTORY_FIELDS = SYNTHESIS_SCHEMA.legacy_v2_input_record_field_order.session_history.split("|");
const KICKOFF_PRODUCT_KINDS = SYNTHESIS_SCHEMA.legacy_kickoff_product_kinds.split("|");

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { mode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prepare" || arg === "--finalize" || arg === "--validate-synthesis" || arg === "--archive") {
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
  if (!out.mode) fail("需要 --prepare、--finalize、--validate-synthesis、--archive 或 --check");
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
  return machineContract.orderRecordByProtocol({
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
  }, SYNTHESIS_SCHEMA.legacy_field_order, SYNTHESIS_SCHEMA.legacy_v1_record_field_order);
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

function readStructuredPacket(packetFile, root) {
  const content = fs.readFileSync(packetFile, "utf8");
  let packet;
  try {
    packet = JSON.parse(content);
  } catch (error) {
    throw new Error(`packet must be strict JSON: ${error.message}`);
  }
  if (
    packet?.kind !== "kg.spec_synthesis_packet" ||
    packet.version !== 2 ||
    packet.readonly !== true ||
    !Array.isArray(packet.transcript) ||
    !Array.isArray(packet.intermediate_products)
  ) {
    throw new Error("packet must be a version 2 read-only synthesis packet");
  }
  if (host.canonicalPath(packet.project_root) !== root) {
    throw new Error("packet project root differs from --project-root");
  }
  return { packet, sha256: machineContract.sha256Bytes(content) };
}

function productSchemaErrors(record, schema, label) {
  const errors = protocol.validateRecord(record, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid: ${errors.join("; ")}`);
}

function legacyFindingId(finding) {
  const seed = machineContract.sha256CanonicalJson({
    source_path: finding.source_path,
    line: finding.line,
  });
  return `KF-${seed.slice(-12).toUpperCase()}`;
}

function legacyConflictId(conflict) {
  const seed = machineContract.sha256CanonicalJson({
    source_path: conflict.source_path,
    line: conflict.line,
  });
  return `KC-${seed.slice(-12).toUpperCase()}`;
}

function structuredPacketFacts(packet, root) {
  const turn = readMachineProduct(productByKind(packet, "kg.kickoff_turn"));
  let findings;
  let turnIds;
  if (turn.version === protocol.loadKickoffTurnSchema().product_version) {
    productSchemaErrors(turn, protocol.loadKickoffTurnSchema(), "packet kg.kickoff_turn");
    // The kickoff harness packs its instructions and the task into one user
    // message, so the turn states the text it responded to and the pointer is
    // grounded by containment in the transcript's bytes rather than equality.
    const userMessage = packet.transcript[turn.user_message_index];
    if (
      !userMessage ||
      userMessage.role !== "user" ||
      machineContract.sha256Bytes(turn.user_message) !== turn.user_message_sha256 ||
      !String(userMessage.content).includes(turn.user_message)
    ) {
      throw new Error("packet kg.kickoff_turn user pointer does not match transcript bytes");
    }
    // The recorded assistant_message is the script-rendered question, which the
    // agent sends inside a longer message carrying its findings. The kickoff
    // gate grounds it by containment for that reason, and the two readers have
    // to agree on the relation or a session can satisfy only one of them.
    const assistantMessage = packet.transcript[turn.question.assistant_message_index];
    if (
      !assistantMessage ||
      assistantMessage.role !== "assistant" ||
      machineContract.sha256Bytes(turn.question.assistant_message) !==
        turn.question.assistant_message_sha256 ||
      !String(assistantMessage.content).includes(turn.question.assistant_message)
    ) {
      throw new Error("packet kg.kickoff_turn assistant pointer does not match transcript bytes");
    }
    findings = turn.findings;
    turnIds = [turn.turn_id];
  } else if (turn.version === 1) {
    findings = (turn.findings ?? []).map((finding) => ({
      finding_id: legacyFindingId(finding),
      ...finding,
    }));
    turnIds = [turn.session_id];
  } else {
    throw new Error("packet kg.kickoff_turn version is unsupported");
  }
  if (findings.length === 0) throw new Error("packet kg.kickoff_turn findings must not be empty");
  const findingById = new Map();
  const findingByAnchor = new Map();
  for (const finding of findings) {
    const anchor = `${finding.source_path}#L${finding.line}`;
    documentAnchor.validateConstraintAnchor(anchor, root, protocol.loadTaskSpecSchema().constraint_source_path_pattern);
    const sourceFile = host.resolveSafeRelative(root, finding.source_path).full;
    const metadata = sourceMetadata(sourceFile, finding.source_path);
    if (finding.status !== metadata.status || finding.authority !== metadata.authority) {
      throw new Error(`packet kickoff finding metadata differs from source bytes: ${anchor}`);
    }
    if (findingById.has(finding.finding_id) || findingByAnchor.has(anchor)) {
      throw new Error(`packet kickoff finding is duplicated: ${anchor}`);
    }
    findingById.set(finding.finding_id, { ...finding, anchor });
    findingByAnchor.set(anchor, { ...finding, anchor });
  }

  const conflictProduct = productByKind(packet, "kg.kickoff_conflicts", { required: false });
  const conflictById = new Map();
  const turnUserMessage = turn.user_message ?? null;
  const turnUserMessageSha = turn.user_message_sha256 ?? null;
  if (conflictProduct) {
    const conflicts = readMachineProduct(conflictProduct);
    if (conflicts.version === protocol.loadKickoffConflictSchema().product_version) {
      productSchemaErrors(conflicts, protocol.loadKickoffConflictSchema(), "packet kg.kickoff_conflicts");
      for (const conflict of conflicts.conflicts) {
        const message = packet.transcript[conflict.task_message_index];
        const finding = findingById.get(conflict.finding_id);
        const sourceFile = host.resolveSafeRelative(root, conflict.constraint_source_path).full;
        // A conflict points at the same user message the turn does, so it is
        // grounded the same way: the recorded task text must hash to the
        // conflict's digest and appear in the transcript message it names.
        // The harness delivers instructions and task together, which is why
        // equality against the whole message is the wrong relation.
        if (
          !message ||
          message.role !== "user" ||
          conflict.task_message_sha256 !== turnUserMessageSha ||
          !String(message.content).includes(turnUserMessage)
        ) {
          throw new Error(`packet conflict task pointer is invalid: ${conflict.conflict_id}`);
        }
        if (
          !finding ||
          finding.source_path !== conflict.constraint_source_path ||
          finding.line !== conflict.constraint_line ||
          machineContract.sha256File(sourceFile) !== conflict.constraint_sha256
        ) {
          throw new Error(`packet conflict constraint pointer is invalid: ${conflict.conflict_id}`);
        }
        conflictById.set(conflict.conflict_id, conflict);
      }
    } else if (conflicts.version === 1 && Array.isArray(conflicts.conflicts)) {
      for (const conflict of conflicts.conflicts) {
        conflictById.set(legacyConflictId(conflict), conflict);
      }
    } else {
      throw new Error("packet kg.kickoff_conflicts version is unsupported");
    }
  }
  return {
    turn,
    findings,
    findingById,
    findingByAnchor,
    turnIds,
    conflictById,
    productKinds: packet.intermediate_products.map((product) => product.kind),
  };
}

function normalizedStringList(value, label, options = {}) {
  return stringList(value, label, options).map((item) => item.trim());
}

function portableReference(value, label) {
  const reference = requireString(value, label).replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(reference) ||
    reference.split("/").includes("..") ||
    reference.split("/").some((segment) => segment.toLowerCase() === ".kg")
  ) {
    throw new Error(`${label} must be a safe project-relative reference`);
  }
  return reference;
}

function numberedRecords(records, prefix, idField) {
  return records.map((record, index) => ({
    [idField]: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    ...record,
  }));
}

function rawFromStructuredProduct(product) {
  return {
    task: { title: product.task.title },
    context: product.context.map(({ statement, source_refs }) => ({ statement, source_refs })),
    requirements: product.requirements.map(({ statement, source_refs }) => ({ statement, source_refs })),
    constraints: product.constraints.map(({ constraint, source_path, source_status, authority, finding_id }) => ({
      constraint,
      source_path,
      source_status,
      authority,
      finding_id,
    })),
    references: product.references.map(({ path: referencePath, purpose }) => ({ path: referencePath, purpose })),
    out_of_scope: product.out_of_scope.map(({ statement, source_class, source_ref }) => ({
      statement,
      source_class,
      source_ref,
    })),
    acceptance_criteria: product.acceptance_criteria.map(({ given, when, then, and, requirement_ids }) => ({
      given,
      when,
      then,
      ...(and === undefined ? {} : { and }),
      requirement_ids,
    })),
    open_questions: product.open_questions.map(({ question, source_refs }) => ({ question, source_refs })),
    session_history: product.session_history.map(({ session_id, turn_ids, product_kinds }) => ({
      session_id,
      turn_ids,
      product_kinds,
    })),
  };
}

function canonicalStructuredSynthesis(raw, packetInfo, root, envelope) {
  machineContract.assertRawInput(raw, SYNTHESIS_SCHEMA, "spec synthesis");
  const facts = structuredPacketFacts(packetInfo.packet, root);
  const task = { title: requireString(raw.task.title, "synthesis.task.title") };
  const context = numberedRecords(raw.context.map((item, index) => ({
    statement: requireString(item.statement, `synthesis.context[${index}].statement`),
    source_refs: normalizedStringList(item.source_refs, `synthesis.context[${index}].source_refs`),
  })), "CTX", "context_id");
  const requirements = numberedRecords(raw.requirements.map((item, index) => ({
    statement: requireString(item.statement, `synthesis.requirements[${index}].statement`),
    source_refs: normalizedStringList(item.source_refs, `synthesis.requirements[${index}].source_refs`),
  })), "REQ", "requirement_id");
  const requirementIds = new Set(requirements.map((item) => item.requirement_id));

  const constraints = numberedRecords(raw.constraints.map((item, index) => {
    const sourcePath = requireString(item.source_path, `synthesis.constraints[${index}].source_path`);
    documentAnchor.validateConstraintAnchor(sourcePath, root, protocol.loadTaskSpecSchema().constraint_source_path_pattern);
    const findingId = requireString(item.finding_id, `synthesis.constraints[${index}].finding_id`);
    const finding = facts.findingById.get(findingId);
    if (!finding || finding.anchor !== sourcePath) {
      throw new Error(`synthesis.constraints[${index}] does not bind its kickoff finding`);
    }
    const status = requireString(item.source_status, `synthesis.constraints[${index}].source_status`);
    const authority = requireString(item.authority, `synthesis.constraints[${index}].authority`);
    if (status !== finding.status || authority !== finding.authority) {
      throw new Error(`synthesis.constraints[${index}] metadata differs from its kickoff finding`);
    }
    return {
      constraint: requireString(item.constraint, `synthesis.constraints[${index}].constraint`),
      source_path: sourcePath,
      source_status: status,
      authority,
      finding_id: findingId,
    };
  }), "CON", "constraint_id");
  exactStringSet(constraints.map((item) => item.finding_id), [...facts.findingById.keys()], "constraint finding set");

  const references = raw.references.map((item, index) => ({
    path: portableReference(item.path, `synthesis.references[${index}].path`),
    purpose: requireString(item.purpose, `synthesis.references[${index}].purpose`),
  }));
  const sourceClasses = SYNTHESIS_SCHEMA.out_of_scope_source_classes;
  const outOfScope = numberedRecords(raw.out_of_scope.map((item, index) => {
    const sourceClass = requireString(item.source_class, `synthesis.out_of_scope[${index}].source_class`);
    const sourceRef = requireString(item.source_ref, `synthesis.out_of_scope[${index}].source_ref`);
    const policy = sourceClasses[sourceClass];
    if (!policy || !new RegExp(policy.source_ref_pattern).test(sourceRef)) {
      throw new Error(`synthesis.out_of_scope[${index}] source_ref does not match ${sourceClass}`);
    }
    if (policy.pointer_type === "transcript_message") {
      const messageIndex = Number.parseInt(sourceRef.split("=").at(-1), 10);
      const message = packetInfo.packet.transcript[messageIndex];
      if (!message || message.role !== "user" || typeof message.content !== "string") {
        throw new Error(`synthesis.out_of_scope[${index}] must point to a user transcript message`);
      }
    } else if (policy.pointer_type === "kickoff_conflict") {
      const conflictId = sourceRef.split("=").at(-1);
      if (!facts.conflictById.has(conflictId)) {
        throw new Error(`synthesis.out_of_scope[${index}] names an absent kickoff conflict`);
      }
    } else if (policy.pointer_type === "decision_anchor") {
      documentAnchor.validateConstraintAnchor(sourceRef, root, protocol.loadTaskSpecSchema().constraint_source_path_pattern);
      const match = /^(.*)#L[1-9][0-9]*$/.exec(sourceRef);
      const metadata = sourceMetadata(host.resolveSafeRelative(root, match[1]).full, match[1]);
      if (!new Set(["accepted", "active"]).has(metadata.status) && metadata.authority !== "project_instruction") {
        throw new Error(`synthesis.out_of_scope[${index}] DMZ source is not a stable decision`);
      }
    }
    return {
      statement: requireString(item.statement, `synthesis.out_of_scope[${index}].statement`),
      source_class: sourceClass,
      source_ref: sourceRef,
    };
  }), "OOS", "out_of_scope_id");
  exactStringSet(outOfScope.map((item) => item.source_ref), outOfScope.map((item) => item.source_ref), "Out of Scope source refs");
  exactStringSet(
    outOfScope
      .filter((item) => item.source_class === "conflict")
      .map((item) => item.source_ref.split("=").at(-1)),
    [...facts.conflictById.keys()],
    "Out of Scope conflict set",
  );

  const acceptanceCriteria = numberedRecords(raw.acceptance_criteria.map((item, index) => {
    const traced = normalizedStringList(item.requirement_ids, `synthesis.acceptance_criteria[${index}].requirement_ids`);
    if (traced.some((requirementId) => !requirementIds.has(requirementId))) {
      throw new Error(`synthesis.acceptance_criteria[${index}] traces an unknown requirement`);
    }
    return {
      given: requireString(item.given, `synthesis.acceptance_criteria[${index}].given`),
      when: requireString(item.when, `synthesis.acceptance_criteria[${index}].when`),
      then: requireString(item.then, `synthesis.acceptance_criteria[${index}].then`),
      ...(item.and === undefined ? {} : {
        and: normalizedStringList(item.and, `synthesis.acceptance_criteria[${index}].and`, { allowEmpty: true }),
      }),
      requirement_ids: traced,
    };
  }), "AC", "acceptance_id");
  const coveredRequirements = new Set(acceptanceCriteria.flatMap((item) => item.requirement_ids));
  const orphanRequirements = [...requirementIds].filter((requirementId) => !coveredRequirements.has(requirementId));
  if (orphanRequirements.length > 0) {
    throw new Error(`requirements lack acceptance coverage: ${orphanRequirements.join(", ")}`);
  }

  const openQuestions = numberedRecords(raw.open_questions.map((item, index) => ({
    question: requireString(item.question, `synthesis.open_questions[${index}].question`),
    source_refs: normalizedStringList(item.source_refs, `synthesis.open_questions[${index}].source_refs`),
  })), "OQ", "question_id");
  const sessionHistory = raw.session_history.map((item, index) => ({
    session_id: requireString(item.session_id, `synthesis.session_history[${index}].session_id`),
    turn_ids: normalizedStringList(item.turn_ids, `synthesis.session_history[${index}].turn_ids`),
    product_kinds: normalizedStringList(item.product_kinds, `synthesis.session_history[${index}].product_kinds`),
  }));
  const matchingHistory = sessionHistory.filter((item) => item.session_id === packetInfo.packet.session_id);
  if (matchingHistory.length !== 1) {
    throw new Error("Session History must bind the packet runner session exactly once");
  }
  exactStringSet(matchingHistory[0].turn_ids, facts.turnIds, "Session History turn_ids");
  exactStringSet(matchingHistory[0].product_kinds, facts.productKinds, "Session History product_kinds");

  const normalizedRaw = {
    task,
    context: context.map(({ context_id: ignored, ...item }) => item),
    requirements: requirements.map(({ requirement_id: ignored, ...item }) => item),
    constraints: constraints.map(({ constraint_id: ignored, ...item }) => item),
    references,
    out_of_scope: outOfScope.map(({ out_of_scope_id: ignored, ...item }) => item),
    acceptance_criteria: acceptanceCriteria.map(({ acceptance_id: ignored, ...item }) => item),
    open_questions: openQuestions.map(({ question_id: ignored, ...item }) => item),
    session_history: sessionHistory,
  };
  const synthesisSeed = machineContract.sha256CanonicalJson({
    packet_sha256: packetInfo.sha256,
    synthesis: normalizedRaw,
  });
  const scriptValues = {
    kind: SYNTHESIS_SCHEMA.product_kind,
    version: SYNTHESIS_SCHEMA.product_version,
    synthesis_id: `KSYN-${synthesisSeed.slice(-12).toUpperCase()}`,
    created_at: envelope.createdAt,
    packet_sha256: packetInfo.sha256,
    task: { task_id: envelope.taskId, status: "draft" },
    context,
    requirements,
    constraints,
    out_of_scope: outOfScope,
    acceptance_criteria: acceptanceCriteria,
    open_questions: openQuestions,
  };
  return machineContract.buildCanonicalRecord(normalizedRaw, scriptValues, SYNTHESIS_SCHEMA, "spec synthesis");
}

function validateStructuredProduct(product, packetInfo, root) {
  const schemaErrors = protocol.validateRecord(product, SYNTHESIS_SCHEMA);
  if (schemaErrors.length > 0) throw new Error(`validated synthesis is invalid: ${schemaErrors.join("; ")}`);
  if (product.packet_sha256 !== packetInfo.sha256) throw new Error("validated synthesis packet hash differs from packet bytes");
  const rebuilt = canonicalStructuredSynthesis(rawFromStructuredProduct(product), packetInfo, root, {
    taskId: product.task.task_id,
    createdAt: product.created_at,
  });
  if (machineContract.canonicalJson(rebuilt) !== machineContract.canonicalJson(product)) {
    throw new Error("validated synthesis differs from the shared canonical validator output");
  }
  return rebuilt;
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

  return machineContract.orderRecordByProtocol({
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
  }, SYNTHESIS_SCHEMA.legacy_field_order, SYNTHESIS_SCHEMA.legacy_v2_record_field_order);
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

function recordMarker(type, record) {
  return `<!-- kg:${type} ${Buffer.from(JSON.stringify(record), "utf8").toString("base64url")} -->`;
}

function sourceSuffix(sourceRefs) {
  return `_(Sources: ${sourceRefs.join("; ")})_`;
}

function renderStructuredList(records, type, display) {
  return records
    .map((record, index) => `${display(record, index)}\n${recordMarker(type, record)}`)
    .join("\n");
}

function acceptanceDisplay(record, index) {
  const andText = (record.and ?? []).map((item) => ` AND ${item}`).join("");
  return `${index + 1}. [${record.acceptance_id}] GIVEN ${record.given} WHEN ${record.when} THEN ${record.then}${andText} _(Requirements: ${record.requirement_ids.join(", ")})_`;
}

function structuredSpecSections(synthesis) {
  const constraintRows = synthesis.constraints.map(
    (item) =>
      `| ${markdownCell(`[${item.constraint_id}] ${item.constraint}`)} | ${markdownCell(item.source_path)} | ${markdownCell(item.source_status)} | ${markdownCell(item.authority)} |`,
  );
  const constraintMarkers = synthesis.constraints.map((item) => recordMarker("constraint", item));
  return {
    Context: renderStructuredList(
      synthesis.context,
      "context",
      (item) => `- [${item.context_id}] ${item.statement} ${sourceSuffix(item.source_refs)}`,
    ),
    Requirements: renderStructuredList(
      synthesis.requirements,
      "requirement",
      (item, index) => `${index + 1}. [${item.requirement_id}] ${item.statement} ${sourceSuffix(item.source_refs)}`,
    ),
    Constraints: [
      "| Constraint | Source | Source Status | Authority |",
      "| --- | --- | --- | --- |",
      ...constraintRows,
      ...constraintMarkers,
    ].join("\n"),
    References: synthesis.references.length
      ? renderStructuredList(
          synthesis.references,
          "reference",
          (item) => `- ${item.path} _(Purpose: ${item.purpose})_`,
        )
      : "- None.",
    "Out of Scope": synthesis.out_of_scope.length
      ? renderStructuredList(
          synthesis.out_of_scope,
          "out_of_scope",
          (item, index) => `${index + 1}. [${item.out_of_scope_id}] ${item.statement} _(Source: ${item.source_class} ${item.source_ref})_`,
        )
      : "- None.",
    "Acceptance Criteria": renderStructuredList(synthesis.acceptance_criteria, "acceptance", acceptanceDisplay),
    "Open Questions": synthesis.open_questions.length
      ? renderStructuredList(
          synthesis.open_questions,
          "open_question",
          (item) => `- [${item.question_id}] ${item.question} ${sourceSuffix(item.source_refs)}`,
        )
      : "- None.",
    "Session History": renderStructuredList(
      synthesis.session_history,
      "session_history",
      (item) => `- Session ${item.session_id}; turns ${item.turn_ids.join(", ")}; products ${item.product_kinds.join(", ")}`,
    ),
  };
}

export function renderSpec(synthesis, envelope = {}) {
  const taskSpecSchema = protocol.loadTaskSpecSchema();
  const frontmatter = machineContract.orderRecordByProtocol({
    kind: "kg.task_spec",
    task_id: envelope.taskId ?? synthesis.task.task_id,
    created_at: envelope.createdAt ?? new Date().toISOString(),
    status: envelope.status ?? synthesis.task.status,
  }, taskSpecSchema.field_order);
  if (synthesis.version === SYNTHESIS_SCHEMA.product_version) {
    const renderedSections = structuredSpecSections(synthesis);
    return [
      "---",
      kyaml.stringify(frontmatter).trimEnd(),
      "---",
      "",
      `# ${synthesis.task.title}`,
      "",
      ...taskSpecSchema.required_sections.flatMap((section) => [
        `## ${section}`,
        "",
        renderedSections[section],
        "",
      ]),
    ].join("\n");
  }
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

export function parseStructuredSpecText(text) {
  const records = {
    context: [],
    requirement: [],
    constraint: [],
    reference: [],
    out_of_scope: [],
    acceptance: [],
    open_question: [],
    session_history: [],
  };
  const markerPattern = /<!-- kg:([a-z_]+) ([A-Za-z0-9_-]+) -->/g;
  let match;
  while ((match = markerPattern.exec(text)) !== null) {
    if (!Object.prototype.hasOwnProperty.call(records, match[1])) {
      throw new Error(`unknown structured spec marker: ${match[1]}`);
    }
    let record;
    try {
      record = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
    } catch (error) {
      throw new Error(`invalid structured spec marker ${match[1]}: ${error.message}`);
    }
    records[match[1]].push(record);
  }
  return records;
}

function visibleStructuredRecordErrors(body, records) {
  const errors = [];
  const displays = [
    ...records.context.map((item) => `- [${item.context_id}] ${item.statement} ${sourceSuffix(item.source_refs)}`),
    ...records.requirement.map((item, index) => `${index + 1}. [${item.requirement_id}] ${item.statement} ${sourceSuffix(item.source_refs)}`),
    ...records.constraint.map(
      (item) => `| ${markdownCell(`[${item.constraint_id}] ${item.constraint}`)} | ${markdownCell(item.source_path)} | ${markdownCell(item.source_status)} | ${markdownCell(item.authority)} |`,
    ),
    ...records.reference.map((item) => `- ${item.path} _(Purpose: ${item.purpose})_`),
    ...records.out_of_scope.map(
      (item, index) => `${index + 1}. [${item.out_of_scope_id}] ${item.statement} _(Source: ${item.source_class} ${item.source_ref})_`,
    ),
    ...records.acceptance.map(acceptanceDisplay),
    ...records.open_question.map((item) => `- [${item.question_id}] ${item.question} ${sourceSuffix(item.source_refs)}`),
    ...records.session_history.map(
      (item) => `- Session ${item.session_id}; turns ${item.turn_ids.join(", ")}; products ${item.product_kinds.join(", ")}`,
    ),
  ];
  for (const display of displays) {
    const count = body.split(/\r?\n/).filter((line) => line === display).length;
    if (count !== 1) errors.push(`structured record display must appear exactly once: ${display}`);
  }
  return errors;
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
  const sectionHeadings = body
    .split(/\r?\n/)
    .filter((line) => /^## /.test(line))
    .map((line) => line.slice(3).trim());
  if (JSON.stringify(sectionHeadings) !== JSON.stringify(sections)) {
    errors.push(`section order must be exactly: ${sections.join(" | ")}`);
  }
  for (const section of sections) {
    const matches = body.split(/\r?\n/).filter((line) => line.trim() === `## ${section}`).length;
    if (matches !== 1) errors.push(`section \`${section}\` must appear exactly once`);
  }
  let structured = null;
  try {
    structured = parseStructuredSpecText(body);
  } catch (error) {
    errors.push(error.message);
  }
  const structuredCount = structured
    ? Object.values(structured).reduce((sum, records) => sum + records.length, 0)
    : 0;
  const outOfScope = sectionBody(body, "Out of Scope", sections);
  if (structuredCount === 0 && (!outOfScope || !/^\d+\.\s+\S/m.test(outOfScope))) {
    errors.push("Out of Scope must contain at least one numbered item");
  }
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
  if (structuredCount > 0 && structured) {
    errors.push(...visibleStructuredRecordErrors(body, structured));
    const titleMatch = /^# (.+)$/m.exec(body);
    const assembled = {
      kind: SYNTHESIS_SCHEMA.product_kind,
      version: SYNTHESIS_SCHEMA.product_version,
      synthesis_id: "KSYN-000000000000",
      created_at: frontmatter.created_at,
      packet_sha256: `sha256:${"0".repeat(64)}`,
      task: {
        task_id: frontmatter.task_id,
        status: frontmatter.status,
        title: titleMatch?.[1] ?? "",
      },
      context: structured.context,
      requirements: structured.requirement,
      constraints: structured.constraint,
      references: structured.reference,
      out_of_scope: structured.out_of_scope,
      acceptance_criteria: structured.acceptance,
      open_questions: structured.open_question,
      session_history: structured.session_history,
    };
    errors.push(...protocol.validateRecord(assembled, SYNTHESIS_SCHEMA));
    const requirementIds = new Set(assembled.requirements.map((item) => item.requirement_id));
    const covered = new Set();
    for (const [index, acceptanceRecord] of assembled.acceptance_criteria.entries()) {
      for (const requirementId of acceptanceRecord.requirement_ids ?? []) {
        if (!requirementIds.has(requirementId)) {
          errors.push(`acceptance marker ${index} traces unknown requirement ${requirementId}`);
        } else {
          covered.add(requirementId);
        }
      }
    }
    for (const requirementId of requirementIds) {
      if (!covered.has(requirementId)) errors.push(`requirement marker ${requirementId} lacks acceptance coverage`);
    }
    for (const [index, item] of assembled.out_of_scope.entries()) {
      const policy = SYNTHESIS_SCHEMA.out_of_scope_source_classes[item.source_class];
      if (!policy || !new RegExp(policy.source_ref_pattern).test(item.source_ref)) {
        errors.push(`Out of Scope marker ${index} has an invalid ${item.source_class} source ref`);
      }
      if (policy?.pointer_type === "decision_anchor") {
        try {
          documentAnchor.validateConstraintAnchor(item.source_ref, root, schema.constraint_source_path_pattern);
        } catch (error) {
          errors.push(error.message);
        }
      }
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

function runValidateSynthesis(args) {
  const root = requireRoot(args.project_root);
  const packetFile = requireFile(args.packet, "--packet");
  const synthesisFile = requireFile(args.synthesis, "--synthesis");
  if (!args.output) fail("缺少 --output");
  const outputFile = path.resolve(args.output);
  if (!host.isOutside(root, outputFile)) fail("--output 必须位于项目根目录之外");
  let packetInfo;
  let raw;
  try {
    packetInfo = readStructuredPacket(packetFile, root);
    const content = fs.readFileSync(synthesisFile, "utf8");
    if (!content.trimStart().startsWith("{")) throw new Error("synthesis draft must be strict JSON");
    raw = JSON.parse(content);
  } catch (error) {
    fail(`synthesis 预检输入无效：${error.message}`);
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`--now 无效：${args.now}`);
  let archive;
  let product;
  try {
    archive = nextTaskArchive(root, now);
    product = canonicalStructuredSynthesis(raw, packetInfo, root, {
      taskId: archive.taskId,
      createdAt: now.toISOString(),
    });
  } catch (error) {
    fail(`synthesis 预检失败：${error.message}`);
  }
  let written;
  try {
    written = machineContract.writeCanonicalRecord(outputFile, product, SYNTHESIS_SCHEMA, {
      label: "validated spec synthesis",
    });
  } catch (error) {
    fail(error.message);
  }
  console.log(JSON.stringify({
    kind: "kg.spec_synthesis_validation_result",
    version: 1,
    synthesis_id: product.synthesis_id,
    packet_sha256: product.packet_sha256,
    product_sha256: written.sha256,
    path: written.file,
  }));
}

function nextTaskArchive(root, now) {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const specs = host.resolveSafeRelative(root, "docs/specs", { mustExist: false });
  const pattern = new RegExp(`^TASK-${day}-([0-9]{3})\\.md$`);
  let max = 0;
  if (fs.existsSync(specs.full)) {
    for (const entry of fs.readdirSync(specs.full, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = pattern.exec(entry.name);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
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
  let packetInfo;
  let synthesis;
  try {
    packetInfo = readStructuredPacket(packetFile, root);
    const content = fs.readFileSync(synthesisFile, "utf8");
    if (!content.trimStart().startsWith("{")) throw new Error("archive synthesis must be JSON");
    const raw = JSON.parse(content);
    const canonical = machineContract.canonicalizeRecord(raw, SYNTHESIS_SCHEMA, "validated spec synthesis");
    const expectedBytes = `${JSON.stringify(canonical, null, 2)}\n`;
    if (content !== expectedBytes) throw new Error("archive synthesis is not a canonical writer product");
    synthesis = validateStructuredProduct(canonical, packetInfo, root);
  } catch (error) {
    fail(`archive synthesis 校验失败：${error.message}`);
  }
  const taskDay = synthesis.created_at.slice(0, 10).replaceAll("-", "");
  if (!synthesis.task.task_id.startsWith(`TASK-${taskDay}-`)) {
    fail("validated synthesis task ID date differs from its script-owned timestamp");
  }
  const archive = {
    taskId: synthesis.task.task_id,
    file: host.resolveSafeRelative(root, `docs/specs/${synthesis.task.task_id}.md`, { mustExist: false }).full,
  };
  const rendered = renderSpec(synthesis, {
    taskId: archive.taskId,
    createdAt: synthesis.created_at,
    status: "draft",
  });
  const errors = validateSpecText(rendered, root);
  if (errors.length) fail(`task spec 校验失败：\n  ${errors.join("\n  ")}`);
  try {
    fs.mkdirSync(path.dirname(archive.file), { recursive: true });
    fs.writeFileSync(archive.file, rendered, { flag: "wx" });
  } catch (error) {
    fail(error.code === "EEXIST" ? `拒绝覆盖已有 archive：${archive.file}` : error.message);
  }
  console.log(JSON.stringify({
    kind: "kg.spec_archive_result",
    version: 1,
    task_id: archive.taskId,
    created_at: synthesis.created_at,
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
  else if (args.mode === "validate-synthesis") runValidateSynthesis(args);
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
