#!/usr/bin/env node

// Lazily create one taxonomy document or produce one content-addressed
// proposal when the taxonomy target already exists.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docsCore, documentAnchor, host, kyaml, machineContract, protocol } from "./_lib.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(["--project-root", "--input", "--transcript", "--output", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (out[key] !== undefined) fail(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  for (const field of ["project_root", "input", "transcript", "output"]) {
    if (!out[field]) fail(`missing --${field.replaceAll("_", "-")}`);
  }
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function readJsonFile(value, label) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg")) throw new Error(`${label} must not enter .kg`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is not a file`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  try {
    return { file: host.canonicalPath(file), value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    throw new Error(`${label} must be strict JSON: ${error.message}`);
  }
}

function transcriptState(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      !Array.isArray(raw.transcript) || !Array.isArray(raw.approvals)) {
    throw new Error("transcript must contain transcript and approvals lists");
  }
  const unknown = Object.keys(raw).filter((field) => !["transcript", "approvals"].includes(field));
  if (unknown.length > 0) throw new Error(`transcript has unknown fields: ${unknown.join(", ")}`);
  return raw;
}

function approvalMessage(transcript, request, requestSchema) {
  const message = transcript.transcript[request.human_approval_message_index];
  if (!message || message.role !== "user" || typeof message.content !== "string") {
    throw new Error("human_approval_message_index must point to a user message");
  }
  const action = `${requestSchema.approval_action_prefix}${request.doc_type}`;
  const approved = transcript.approvals.some(
    (item) => item?.message_index === request.human_approval_message_index && item?.action === action,
  );
  if (!approved) throw new Error(`structured human approval is missing for ${request.doc_type}`);
  return message;
}

function validateSourceRefs(projectRoot, refs) {
  return refs.map((ref, index) => {
    const match = /^(.*)#L([1-9][0-9]*)$/.exec(ref);
    if (!match) throw new Error(`source_refs[${index}] must be path#L<number>`);
    try {
      const anchor = documentAnchor.validateStableDocumentReference({
        sourcePath: match[1],
        line: Number.parseInt(match[2], 10),
        projectRoot,
      });
      return `${anchor.sourcePath}#L${anchor.line}`;
    } catch (error) {
      throw new Error(`source_refs[${index}]: ${error.message}`);
    }
  });
}

function assessmentForRequest(request, transcript, projectRoot) {
  if (request.doc_type !== "decision") {
    if (request.adr_assessment !== null || request.candidate_ref !== null) {
      throw new Error("non-decision scaffold must not include ADR assessment or candidate_ref");
    }
    return null;
  }
  if (typeof request.adr_assessment !== "string" || typeof request.candidate_ref !== "string") {
    throw new Error("decision scaffold requires adr_assessment and candidate_ref");
  }
  const assessmentFile = path.isAbsolute(request.adr_assessment)
    ? path.resolve(request.adr_assessment)
    : path.resolve(projectRoot, ...request.adr_assessment.replaceAll("\\", "/").split("/"));
  if (host.hasPathSegment(assessmentFile, ".kg") || !fs.existsSync(assessmentFile) ||
      !fs.statSync(assessmentFile).isFile() || fs.lstatSync(assessmentFile).isSymbolicLink()) {
    throw new Error("ADR assessment path is unsafe or missing");
  }
  const text = fs.readFileSync(assessmentFile, "utf8");
  const value = path.extname(assessmentFile).toLowerCase() === ".json"
    ? JSON.parse(text)
    : kyaml.parse(text);
  const schema = protocol.loadAdrAssessmentSchema();
  const errors = protocol.validateRecord(value, schema);
  if (errors.length > 0) throw new Error(`ADR assessment is invalid: ${errors.join("; ")}`);
  if (value.candidate_ref !== request.candidate_ref) throw new Error("ADR assessment candidate_ref differs from scaffold request");
  if (value.eligible_for_draft !== true || value.criteria.some((criterion) => criterion.conclusion !== true)) {
    throw new Error("ADR assessment is not eligible for a decision draft");
  }
  const approval = transcript.transcript[value.human_approval_message_index];
  if (!approval || machineContract.sha256Bytes(approval.content) !== value.human_approval_sha256) {
    throw new Error("ADR assessment human approval pointer does not match transcript bytes");
  }
  return { file: host.canonicalPath(assessmentFile), value };
}

function outputFile(value) {
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase())) throw new Error("output must use .json or .yaml");
  if (host.hasPathSegment(file, ".kg")) throw new Error("output must not enter .kg");
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite scaffold result: ${file}`);
  const parent = path.dirname(file);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error("output parent must be an existing real directory");
  }
  return file;
}

function run(args) {
  const projectRoot = host.assertSafeHostRoot(args.project_root);
  const requestFile = readJsonFile(args.input, "input");
  const transcript = transcriptState(readJsonFile(args.transcript, "transcript").value);
  const requestSchema = protocol.loadDocsScaffoldRequestSchema();
  const errors = protocol.validateRecord(requestFile.value, requestSchema);
  if (errors.length > 0) throw new Error(`scaffold request is invalid: ${errors.join("; ")}`);
  const taxonomyState = docsCore.loadTaxonomyAndTemplates(SKILL_ROOT);
  const template = taxonomyState.templates.get(requestFile.value.doc_type);
  if (!template) throw new Error(`unknown taxonomy doc_type: ${requestFile.value.doc_type}`);
  const request = {
    ...requestFile.value,
    source_refs: validateSourceRefs(projectRoot, requestFile.value.source_refs),
    sections: docsCore.canonicalScaffoldSections(requestFile.value.sections, template),
  };
  approvalMessage(transcript, request, requestSchema);
  const assessment = assessmentForRequest(request, transcript, projectRoot);
  const output = outputFile(args.output);
  const route = docsCore.deriveTarget({ projectRoot, template, slug: request.slug });
  route.docType = request.doc_type;
  docsCore.preflightPathSegments(projectRoot, route.targetPath, "target");
  if (route.mode === "create" && fs.existsSync(route.target)) throw new Error(`scaffold target already exists: ${route.targetPath}`);
  if (route.mode === "proposal" && (!fs.existsSync(route.target) || !fs.statSync(route.target).isFile())) {
    throw new Error(`proposal target is missing: ${route.targetPath}`);
  }
  const requestSha256 = machineContract.sha256File(requestFile.file);
  const candidateText = docsCore.renderScaffoldDocument(request, template, route.targetPath, requestSha256);
  let proposal = null;
  if (route.mode === "proposal") {
    proposal = docsCore.prepareProposal({
      projectRoot,
      prefix: "scaffold",
      kind: "kg.docs_scaffold_proposal",
      route,
      candidateText,
      identity: { request_sha256: requestSha256.slice("sha256:".length) },
      sourceRefs: request.source_refs,
    });
    docsCore.preflightProposal(projectRoot, proposal);
  }
  const resultSchema = protocol.loadDocsScaffoldResultSchema();
  const scaffoldSeed = machineContract.sha256CanonicalJson({ request_sha256: requestSha256, target_path: route.targetPath });
  const result = machineContract.canonicalizeRecord({
    kind: resultSchema.product_kind,
    version: resultSchema.product_version,
    scaffold_id: `SCAFFOLD-${scaffoldSeed.slice(-12).toUpperCase()}`,
    created_at: args.now.toISOString(),
    doc_type: request.doc_type,
    target_path: route.targetPath,
    mode: route.mode === "create" ? "created" : "proposal",
    document_sha256: machineContract.sha256Bytes(candidateText),
    proposal_path: proposal?.bundlePath ?? null,
    assessment_ref: assessment?.file ?? null,
    approval_message_index: request.human_approval_message_index,
    status: "draft",
  }, resultSchema, "scaffold result");

  const resultText = path.extname(output).toLowerCase() === ".json"
    ? `${JSON.stringify(result, null, 2)}\n`
    : kyaml.stringify(result);
  const createdFiles = [];
  const createdDirectories = [];
  try {
    if (route.mode === "create") docsCore.ensureDirectory(path.dirname(route.target), projectRoot, createdDirectories);
    else if (!proposal.reused) docsCore.ensureDirectory(proposal.bundle, projectRoot, createdDirectories);
    if (route.mode === "create") docsCore.writeExclusive(route.target, candidateText, createdFiles);
    else if (!proposal.reused) {
      docsCore.writeExclusive(proposal.candidate, proposal.candidateText, createdFiles);
      docsCore.writeExclusive(proposal.manifest, proposal.manifestText, createdFiles);
    }
    docsCore.writeExclusive(output, resultText, createdFiles);
  } catch (error) {
    docsCore.rollbackWrites(createdFiles, createdDirectories);
    throw error;
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = run(parseArgs(argv));
    console.log(`kg: scaffold ${result.mode} ${result.doc_type} at ${result.target_path}`);
  } catch (error) {
    fail(error.message);
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
