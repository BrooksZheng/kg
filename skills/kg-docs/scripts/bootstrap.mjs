#!/usr/bin/env node

// Validate an agent-authored JSON bootstrap plan against one static inventory,
// rebuild a canonical plan, and render project-document drafts atomically.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host, kyaml, protocol, repository } from "./_lib.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V1_TARGET = "docs/architecture/overview.md";
const V1_PLAN_FIELDS = [
  "kind",
  "version",
  "title",
  "coverage_limitations",
  "observed_facts",
  "inferences",
];
const V1_FACT_FIELDS = ["section", "statement", "source"];
const V1_INFERENCE_FIELDS = ["section", "statement", "confidence", "sources"];
const V1_SECTIONS = new Map([
  ["context", "上下文与边界（C4 System Context）"],
  ["building_blocks", "构建块视图（C4 Container）"],
  ["runtime", "运行时视图"],
  ["deployment", "部署视图"],
]);

const V2_PLAN_FIELDS = ["kind", "version", "documents"];
const V2_DOCUMENT_FIELDS = [
  "doc_type",
  "slug",
  "title",
  "mode",
  "target_path",
  "coverage_limitations",
  "sections",
];
const V2_SECTION_FIELDS = ["key", "findings"];
const SOURCE_FIELDS = ["path", "line_start", "line_end"];
const FINDING_FIELDS = {
  observed_fact: ["classification", "statement", "sources"],
  inference: ["classification", "statement", "confidence", "sources"],
  conflict: ["classification", "statement", "sources"],
  unknown: ["classification", "statement", "sources", "missing_evidence"],
};

function parseArgs(argv) {
  const out = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      out.check = true;
      continue;
    }
    if (!["--project-root", "--inventory", "--plan"].includes(flag)) host.fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) host.fail(`${flag} needs a value`);
    out[flag.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (!out.project_root || !out.inventory || !out.plan) {
    host.fail("usage: bootstrap.mjs --project-root <root> --inventory <inventory.json> --plan <plan.json> [--check]");
  }
  return out;
}

function readJsonFile(value, label) {
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg") || host.hasPathSegment(host.canonicalPath(file), ".kg")) {
    throw new Error(`${label} must not be inside .kg`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} does not exist: ${file}`);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  try {
    return { file, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function rejectUnknown(record, allowed, label) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim().replace(/\s+/g, " ");
}

function stringList(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
    throw new Error(`${label} must be a list of non-empty strings`);
  }
  return value.map((item) => item.trim().replace(/\s+/g, " "));
}

function sourceReference(source) {
  const suffix = source.line_start === source.line_end
    ? `#L${source.line_start}`
    : `#L${source.line_start}-L${source.line_end}`;
  return `${source.path}${suffix}`;
}

function markdownText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function loadTaxonomyAndTemplates() {
  const taxonomy = protocol.loadDocumentTaxonomy();
  if (taxonomy.kind !== "kg.document_taxonomy" || taxonomy.version !== 1) {
    throw new Error("document taxonomy kind or version is invalid");
  }
  if (!Array.isArray(taxonomy.core_types) || taxonomy.core_types.length === 0) {
    throw new Error("document taxonomy core_types must be a non-empty list");
  }
  if (new Set(taxonomy.core_types).size !== taxonomy.core_types.length) {
    throw new Error("document taxonomy core_types contains duplicates");
  }
  const templates = new Map();
  for (const docType of taxonomy.core_types) {
    const record = taxonomy.documents?.[docType];
    if (!record || typeof record !== "object") throw new Error(`taxonomy document record missing: ${docType}`);
    for (const field of ["path", "template_path", "create_target_pattern"]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        throw new Error(`taxonomy ${docType}.${field} is missing`);
      }
    }
    const prefix = "skills/kg-docs/";
    if (!record.template_path.startsWith(prefix)) {
      throw new Error(`taxonomy ${docType}.template_path must stay inside skills/kg-docs`);
    }
    const templateRelative = record.template_path.slice(prefix.length);
    const template = host.resolveSafeRelative(SKILL_ROOT, templateRelative);
    if (!fs.statSync(template.full).isFile()) throw new Error(`template is not a file: ${record.template_path}`);
    const text = fs.readFileSync(template.full, "utf8");
    const titleMatches = [...text.matchAll(/^# \{\{title\}\}$/gm)];
    if (titleMatches.length !== 1) throw new Error(`template ${record.template_path} must contain one title placeholder`);
    const sections = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->\r?\n## ([^\r\n]+)$/gm)].map(
      (match) => ({ key: match[1], heading: match[2] }),
    );
    const placeholders = [...text.matchAll(/\{\{findings:([a-z][a-z0-9_]*)\}\}/g)].map((match) => match[1]);
    if (sections.length === 0 || new Set(sections.map((item) => item.key)).size !== sections.length) {
      throw new Error(`template ${record.template_path} has missing or duplicate section markers`);
    }
    if (JSON.stringify(placeholders) !== JSON.stringify(sections.map((item) => item.key))) {
      throw new Error(`template ${record.template_path} finding placeholders do not match section markers`);
    }
    const placeholdersInTarget = [...record.create_target_pattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (placeholdersInTarget.some((item) => !["slug", "sequence"].includes(item))) {
      throw new Error(`taxonomy ${docType}.create_target_pattern has an unknown placeholder`);
    }
    if (placeholdersInTarget.filter((item) => item === "slug").length > 1 || placeholdersInTarget.filter((item) => item === "sequence").length > 1) {
      throw new Error(`taxonomy ${docType}.create_target_pattern repeats a placeholder`);
    }
    const sampleTarget = record.create_target_pattern.replace("{slug}", "sample").replace("{sequence}", "0001");
    if (!sampleTarget.endsWith(".md") || path.isAbsolute(sampleTarget) || sampleTarget.split("/").includes("..")) {
      throw new Error(`taxonomy ${docType}.create_target_pattern is unsafe`);
    }
    const routePrefix = record.path.endsWith("/") ? record.path : `${record.path}/`;
    if (record.path.endsWith("/") ? !sampleTarget.startsWith(routePrefix) : sampleTarget !== record.path) {
      throw new Error(`taxonomy ${docType}.create_target_pattern is outside its declared path`);
    }
    templates.set(docType, { ...record, sections, targetPlaceholders: placeholdersInTarget });
  }
  return { taxonomy, templates };
}

function canonicalPlanV1(raw, inventory, inventoryState) {
  rejectUnknown(raw, V1_PLAN_FIELDS, "plan");
  if (raw.kind !== "kg.docs_bootstrap_plan" || raw.version !== 1) throw new Error("plan kind or version is invalid");
  const coverageLimitations = stringList(raw.coverage_limitations, "plan.coverage_limitations");
  if (inventory.truncated && coverageLimitations.length === 0) {
    throw new Error("truncated inventory requires at least one coverage limitation");
  }
  if (!Array.isArray(raw.observed_facts) || raw.observed_facts.length === 0) {
    throw new Error("plan.observed_facts must be a non-empty list");
  }
  if (!Array.isArray(raw.inferences)) throw new Error("plan.inferences must be a list");
  const section = (value, label) => {
    if (!V1_SECTIONS.has(value)) throw new Error(`${label} must be one of: ${[...V1_SECTIONS.keys()].join(" | ")}`);
    return value;
  };
  const observedFacts = raw.observed_facts.map((item, index) => {
    rejectUnknown(item, V1_FACT_FIELDS, `plan.observed_facts[${index}]`);
    return {
      section: section(item.section, `plan.observed_facts[${index}].section`),
      statement: nonEmptyString(item.statement, `plan.observed_facts[${index}].statement`),
      source: repository.validateInventorySource(item.source, inventoryState),
    };
  });
  const inferences = raw.inferences.map((item, index) => {
    rejectUnknown(item, V1_INFERENCE_FIELDS, `plan.inferences[${index}]`);
    if (typeof item.confidence !== "number" || Number.isNaN(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`plan.inferences[${index}].confidence must be between 0 and 1`);
    }
    if (!Array.isArray(item.sources) || item.sources.length === 0) {
      throw new Error(`plan.inferences[${index}].sources must be a non-empty list`);
    }
    return {
      section: section(item.section, `plan.inferences[${index}].section`),
      statement: nonEmptyString(item.statement, `plan.inferences[${index}].statement`),
      confidence: item.confidence,
      sources: item.sources.map((source) => repository.validateInventorySource(source, inventoryState)),
    };
  });
  return {
    kind: "kg.docs_bootstrap_plan",
    version: 1,
    title: nonEmptyString(raw.title, "plan.title"),
    coverage_limitations: coverageLimitations,
    observed_facts: observedFacts,
    inferences,
  };
}

function canonicalFinding(raw, label, inventoryState) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  const allowed = FINDING_FIELDS[raw.classification];
  if (!allowed) throw new Error(`${label}.classification is invalid`);
  rejectUnknown(raw, allowed, label);
  if (!Array.isArray(raw.sources)) throw new Error(`${label}.sources must be a list`);
  const sources = raw.sources.map((source, index) => {
    rejectUnknown(source, SOURCE_FIELDS, `${label}.sources[${index}]`);
    return repository.validateInventorySource(source, inventoryState);
  });
  const finding = {
    classification: raw.classification,
    statement: nonEmptyString(raw.statement, `${label}.statement`),
    sources,
  };
  if (raw.classification === "observed_fact" && sources.length === 0) {
    throw new Error(`${label}.sources must contain at least one inventoried source for observed_fact`);
  }
  if (raw.classification === "inference") {
    if (typeof raw.confidence !== "number" || Number.isNaN(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
      throw new Error(`${label}.confidence must be between 0 and 1 for inference`);
    }
    if (sources.length === 0) throw new Error(`${label}.sources must be non-empty for inference`);
    finding.confidence = raw.confidence;
  }
  if (raw.classification === "conflict") {
    if (sources.length < 2) throw new Error(`${label}.sources must contain at least two conflicting sources`);
    const identities = sources.map((source) => JSON.stringify(source));
    if (new Set(identities).size < 2) throw new Error(`${label}.sources must contain two distinct conflicting sources`);
  }
  if (raw.classification === "unknown") {
    if (sources.length !== 0) throw new Error(`${label}.sources must be empty for unknown`);
    finding.missing_evidence = nonEmptyString(raw.missing_evidence, `${label}.missing_evidence`);
  }
  return finding;
}

function canonicalPlanV2(raw, inventory, inventoryState, taxonomyState) {
  rejectUnknown(raw, V2_PLAN_FIELDS, "plan");
  if (raw.kind !== "kg.docs_bootstrap_plan" || raw.version !== 2) throw new Error("plan kind or version is invalid");
  if (!Array.isArray(raw.documents)) throw new Error("plan.documents must be a list");
  const byType = new Map();
  for (const [index, item] of raw.documents.entries()) {
    rejectUnknown(item, V2_DOCUMENT_FIELDS, `plan.documents[${index}]`);
    if (!taxonomyState.taxonomy.core_types.includes(item.doc_type)) {
      throw new Error(`plan.documents[${index}].doc_type is not a taxonomy core type`);
    }
    if (byType.has(item.doc_type)) throw new Error(`plan contains duplicate doc_type: ${item.doc_type}`);
    const template = taxonomyState.templates.get(item.doc_type);
    const needsSlug = template.targetPlaceholders.includes("slug");
    let slug = null;
    if (needsSlug) {
      if (typeof item.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)) {
        throw new Error(`plan.documents[${index}].slug must be a lowercase safe slug`);
      }
      slug = item.slug;
    } else if (item.slug !== null) {
      throw new Error(`plan.documents[${index}].slug must be null for fixed taxonomy targets`);
    }
    if (item.mode !== "create") throw new Error(`plan.documents[${index}].mode must be create in R3.3`);
    if (item.target_path !== null) throw new Error(`plan.documents[${index}].target_path must be null for create mode`);
    const coverageLimitations = stringList(item.coverage_limitations, `plan.documents[${index}].coverage_limitations`);
    if (inventory.truncated && coverageLimitations.length === 0) {
      throw new Error(`truncated inventory requires coverage_limitations for ${item.doc_type}`);
    }
    if (!Array.isArray(item.sections)) throw new Error(`plan.documents[${index}].sections must be a list`);
    const sectionByKey = new Map();
    for (const [sectionIndex, rawSection] of item.sections.entries()) {
      const sectionLabel = `plan.documents[${index}].sections[${sectionIndex}]`;
      rejectUnknown(rawSection, V2_SECTION_FIELDS, sectionLabel);
      if (!template.sections.some((section) => section.key === rawSection.key)) {
        throw new Error(`${sectionLabel}.key is not declared by ${template.template_path}`);
      }
      if (sectionByKey.has(rawSection.key)) throw new Error(`${sectionLabel}.key is duplicated`);
      if (!Array.isArray(rawSection.findings) || rawSection.findings.length === 0) {
        throw new Error(`${sectionLabel}.findings must be a non-empty list`);
      }
      sectionByKey.set(rawSection.key, {
        key: rawSection.key,
        findings: rawSection.findings.map((finding, findingIndex) =>
          canonicalFinding(finding, `${sectionLabel}.findings[${findingIndex}]`, inventoryState)),
      });
    }
    const expectedKeys = template.sections.map((section) => section.key);
    if (sectionByKey.size !== expectedKeys.length || expectedKeys.some((key) => !sectionByKey.has(key))) {
      throw new Error(`plan document ${item.doc_type} must contain every section from ${template.template_path}`);
    }
    byType.set(item.doc_type, {
      doc_type: item.doc_type,
      slug,
      title: nonEmptyString(item.title, `plan.documents[${index}].title`),
      mode: "create",
      target_path: null,
      coverage_limitations: coverageLimitations,
      sections: expectedKeys.map((key) => sectionByKey.get(key)),
    });
  }
  const missing = taxonomyState.taxonomy.core_types.filter((docType) => !byType.has(docType));
  if (missing.length || byType.size !== taxonomyState.taxonomy.core_types.length) {
    throw new Error(`plan.documents must contain every taxonomy core type exactly once; missing: ${missing.join(", ") || "none"}`);
  }
  return {
    kind: "kg.docs_bootstrap_plan",
    version: 2,
    inventory_sha256: repository.inventoryDigest(inventory),
    documents: taxonomyState.taxonomy.core_types.map((docType) => byType.get(docType)),
  };
}

function renderV1Document(plan) {
  const sourceRefs = [];
  for (const fact of plan.observed_facts) sourceRefs.push(sourceReference(fact.source));
  for (const inference of plan.inferences) for (const source of inference.sources) sourceRefs.push(sourceReference(source));
  const frontmatter = {
    kind: "kg.project_document",
    title: plan.title,
    doc_type: "architecture",
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: [...new Set(sourceRefs)],
  };
  const errors = protocol.validateRecord(frontmatter, protocol.loadProjectDocumentSchema());
  if (errors.length) throw new Error(`rendered frontmatter is invalid: ${errors.join("; ")}`);
  const lines = ["---", kyaml.stringify(frontmatter).trimEnd(), "---", "", `# ${markdownText(plan.title)}`, ""];
  if (plan.coverage_limitations.length) {
    lines.push("## 覆盖限制", "", ...plan.coverage_limitations.map((item) => `- ${markdownText(item)}`), "");
  }
  for (const [sectionKey, heading] of V1_SECTIONS) {
    lines.push(`## ${heading}`, "");
    const facts = plan.observed_facts.filter((item) => item.section === sectionKey);
    const inferences = plan.inferences.filter((item) => item.section === sectionKey);
    for (const fact of facts) {
      lines.push(
        `<!-- kg:fact-source ${JSON.stringify(fact.source)} -->`,
        `- **事实**：${markdownText(fact.statement)}（来源：\`${sourceReference(fact.source)}\`）`,
      );
    }
    for (const inference of inferences) {
      const refs = inference.sources.map((source) => `\`${sourceReference(source)}\``).join("、");
      lines.push(`- **推断（confidence ${inference.confidence.toFixed(2)}）**：${markdownText(inference.statement)}（证据：${refs}）`);
    }
    if (facts.length === 0 && inferences.length === 0) lines.push("- 暂无经证据绑定的内容。");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function evidenceMarker(payload) {
  return `<!-- kg:evidence ${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")} -->`;
}

function humanFinding(finding) {
  const refs = finding.sources.map((source) => `\`${sourceReference(source)}\``).join(", ");
  if (finding.classification === "observed_fact") {
    return `- **Observed fact**: ${markdownText(finding.statement)} (sources: ${refs})`;
  }
  if (finding.classification === "inference") {
    return `- **Inference (confidence ${finding.confidence.toFixed(2)})**: ${markdownText(finding.statement)} (sources: ${refs})`;
  }
  if (finding.classification === "conflict") {
    return `- **Conflict**: ${markdownText(finding.statement)} (conflicting sources: ${refs})`;
  }
  return `- **Unknown**: ${markdownText(finding.statement)} (missing evidence: ${markdownText(finding.missing_evidence)})`;
}

function renderV2Document(plan, document, template, targetPath) {
  const sourceRefs = [];
  for (const section of document.sections) {
    for (const finding of section.findings) for (const source of finding.sources) sourceRefs.push(sourceReference(source));
  }
  const frontmatter = {
    kind: "kg.project_document",
    title: document.title,
    doc_type: document.doc_type,
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: [...new Set(sourceRefs)],
    coverage_limitations: document.coverage_limitations,
  };
  const errors = protocol.validateRecord(frontmatter, protocol.loadProjectDocumentSchema());
  if (errors.length) throw new Error(`rendered ${document.doc_type} frontmatter is invalid: ${errors.join("; ")}`);
  const documentMarker = evidenceMarker({
    kind: "kg.bootstrap_document",
    version: 2,
    inventory_sha256: plan.inventory_sha256,
    doc_type: document.doc_type,
    target_path: targetPath,
    coverage_limitations: document.coverage_limitations,
  });
  const lines = [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${markdownText(document.title)}`,
    "",
    documentMarker,
    "",
  ];
  if (document.coverage_limitations.length) {
    lines.push("## Coverage Limitations", "", ...document.coverage_limitations.map((item) => `- ${markdownText(item)}`), "");
  }
  for (const sectionTemplate of template.sections) {
    const section = document.sections.find((item) => item.key === sectionTemplate.key);
    lines.push(`<!-- kg:section ${sectionTemplate.key} -->`, `## ${sectionTemplate.heading}`, "");
    for (const finding of section.findings) {
      lines.push(evidenceMarker({ section: section.key, ...finding }), humanFinding(finding));
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sequencePattern(template, slug = null) {
  let value = escapeRegex(path.posix.basename(template.create_target_pattern));
  value = value.replace("\\{sequence\\}", "(?<sequence>[0-9]{4})");
  value = value.replace("\\{slug\\}", slug === null ? "[a-z0-9]+(?:-[a-z0-9]+)*" : escapeRegex(slug));
  return new RegExp(`^${value}$`);
}

function existingSequenceFiles(projectRoot, template) {
  const directoryRelative = path.posix.dirname(template.create_target_pattern);
  const directory = host.resolveSafeRelative(projectRoot, directoryRelative, { mustExist: false });
  if (!fs.existsSync(directory.full)) return [];
  if (!fs.statSync(directory.full).isDirectory()) throw new Error(`taxonomy target parent is not a directory: ${directoryRelative}`);
  const matcher = sequencePattern(template);
  return fs.readdirSync(directory.full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => ({ name: entry.name, sequence: Number.parseInt(matcher.exec(entry.name).groups.sequence, 10) }))
    .sort((left, right) => left.sequence - right.sequence);
}

function deriveV2Targets(projectRoot, plan, taxonomyState, check) {
  const routes = [];
  for (const document of plan.documents) {
    const template = taxonomyState.templates.get(document.doc_type);
    let targetPath;
    if (template.targetPlaceholders.includes("sequence")) {
      const existing = existingSequenceFiles(projectRoot, template);
      const exact = existing.filter((item) => sequencePattern(template, document.slug).test(item.name));
      if (check) {
        if (exact.length !== 1) throw new Error(`check requires exactly one existing ${document.doc_type} target for slug ${document.slug}`);
        targetPath = path.posix.join(path.posix.dirname(template.create_target_pattern), exact[0].name);
      } else {
        if (exact.length > 0) throw new Error(`${document.doc_type} target for slug already exists: ${document.slug}`);
        const next = (existing.at(-1)?.sequence ?? 0) + 1;
        if (next > 9999) throw new Error(`${document.doc_type} sequence is exhausted`);
        targetPath = template.create_target_pattern
          .replace("{sequence}", String(next).padStart(4, "0"))
          .replace("{slug}", document.slug);
      }
    } else {
      targetPath = template.create_target_pattern.replace("{slug}", document.slug ?? "");
    }
    const resolved = host.resolveSafeRelative(projectRoot, targetPath, { mustExist: check });
    routes.push({ document, template, targetPath, target: resolved.full });
  }
  if (new Set(routes.map((route) => host.canonicalPath(route.target))).size !== routes.length) {
    throw new Error("taxonomy routes produce duplicate canonical targets");
  }
  return routes;
}

function preflightTarget(projectRoot, route, check) {
  const segments = route.targetPath.split("/");
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`target path contains a symbolic link: ${route.targetPath}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`target parent is not a directory: ${route.targetPath}`);
    }
  }
  if (check) {
    if (!fs.existsSync(route.target) || !fs.statSync(route.target).isFile()) {
      throw new Error(`bootstrap target does not exist: ${route.targetPath}`);
    }
  } else if (fs.existsSync(route.target)) {
    throw new Error(`bootstrap target already exists: ${route.targetPath}; proposal mode belongs to R3.4`);
  }
}

function ensureDirectory(directory, projectRoot, createdDirectories) {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error(`target parent is unsafe: ${path.relative(projectRoot, directory)}`);
    }
    return;
  }
  ensureDirectory(path.dirname(directory), projectRoot, createdDirectories);
  try {
    fs.mkdirSync(directory);
    createdDirectories.push(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw error;
  }
}

function writeExclusive(file, content, createdFiles) {
  const descriptor = fs.openSync(file, "wx");
  createdFiles.push(file);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rollbackWrites(createdFiles, createdDirectories) {
  for (const file of [...createdFiles].reverse()) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Preserve the original error. A later full check will expose residue.
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Concurrently used directories remain intact.
    }
  }
}

const args = parseArgs(process.argv.slice(2));
let projectRoot;
let inventory;
let inventoryState;
let rawPlan;
try {
  projectRoot = host.assertSafeHostRoot(args.project_root);
  inventory = readJsonFile(args.inventory, "inventory").value;
  inventoryState = repository.validateRepositoryInventory(inventory, projectRoot);
  rawPlan = readJsonFile(args.plan, "plan").value;
} catch (error) {
  host.fail(error.message);
}

if (rawPlan?.version === 1) {
  let plan, target, expected;
  try {
    plan = canonicalPlanV1(rawPlan, inventory, inventoryState);
    target = host.resolveSafeRelative(projectRoot, V1_TARGET, { mustExist: args.check }).full;
    expected = renderV1Document(plan);
    preflightTarget(projectRoot, { targetPath: V1_TARGET, target }, args.check);
  } catch (error) {
    host.fail(error.message);
  }
  if (args.check) {
    if (fs.readFileSync(target, "utf8") !== expected) host.fail(`bootstrap target does not match validated plan: ${V1_TARGET}`);
    console.log(`kg: bootstrap document matches inventory and version 1 plan: ${V1_TARGET}`);
    process.exit(0);
  }
  const createdFiles = [];
  const createdDirectories = [];
  try {
    ensureDirectory(path.dirname(target), projectRoot, createdDirectories);
    writeExclusive(target, expected, createdFiles);
  } catch (error) {
    rollbackWrites(createdFiles, createdDirectories);
    host.fail(error.message);
  }
  console.log(`kg: created ${V1_TARGET} from ${plan.observed_facts.length} observed fact(s) and ${plan.inferences.length} inference(s)`);
  process.exit(0);
}

let taxonomyState, plan, routes;
try {
  taxonomyState = loadTaxonomyAndTemplates();
  plan = canonicalPlanV2(rawPlan, inventory, inventoryState, taxonomyState);
  routes = deriveV2Targets(projectRoot, plan, taxonomyState, args.check);
  for (const route of routes) {
    preflightTarget(projectRoot, route, args.check);
    route.expected = renderV2Document(plan, route.document, route.template, route.targetPath);
  }
} catch (error) {
  host.fail(error.message);
}

if (args.check) {
  for (const route of routes) {
    if (fs.readFileSync(route.target, "utf8") !== route.expected) {
      host.fail(`bootstrap target does not match validated version 2 plan: ${route.targetPath}`);
    }
  }
  console.log(`kg: ${routes.length} bootstrap documents match inventory and canonical version 2 plan`);
  process.exit(0);
}

const createdFiles = [];
const createdDirectories = [];
try {
  for (const route of routes) ensureDirectory(path.dirname(route.target), projectRoot, createdDirectories);
  for (const route of routes) writeExclusive(route.target, route.expected, createdFiles);
} catch (error) {
  rollbackWrites(createdFiles, createdDirectories);
  host.fail(error.message);
}
console.log(`kg: created ${routes.length} bootstrap documents from canonical version 2 plan`);
for (const route of routes) console.log(`kg: created ${route.document.doc_type} ${route.targetPath}`);
