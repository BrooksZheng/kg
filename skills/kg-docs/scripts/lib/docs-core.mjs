// Shared mechanical core for kg-docs bootstrap and single-target scaffold.
// Taxonomy routes and template section markers are runtime authority under
// KN-0034. Adapters keep their distinct input contracts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";
import * as kyaml from "./kyaml.mjs";
import * as protocol from "./protocol.mjs";
import * as repository from "./repository.mjs";

export function markdownText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function sourceReference(source) {
  const suffix = source.line_start === source.line_end
    ? `#L${source.line_start}`
    : `#L${source.line_start}-L${source.line_end}`;
  return `${source.path}${suffix}`;
}

export function documentSourceRefs(document) {
  const refs = [];
  for (const section of document.sections) {
    for (const finding of section.findings) {
      for (const source of finding.sources) refs.push(sourceReference(source));
    }
  }
  return [...new Set(refs)];
}

export function evidenceMarker(payload) {
  return `<!-- kg:evidence ${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")} -->`;
}

function parseTemplate(text, templatePath) {
  const titleMatches = [...text.matchAll(/^# \{\{title\}\}$/gm)];
  if (titleMatches.length !== 1) throw new Error(`template ${templatePath} must contain one title placeholder`);
  const sections = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->\r?\n## ([^\r\n]+)$/gm)].map(
    (match) => ({ key: match[1], heading: match[2] }),
  );
  const placeholders = [...text.matchAll(/\{\{findings:([a-z][a-z0-9_]*)\}\}/g)].map((match) => match[1]);
  if (sections.length === 0 || new Set(sections.map((item) => item.key)).size !== sections.length) {
    throw new Error(`template ${templatePath} has missing or duplicate section markers`);
  }
  if (JSON.stringify(placeholders) !== JSON.stringify(sections.map((item) => item.key))) {
    throw new Error(`template ${templatePath} finding placeholders do not match section markers`);
  }
  const adrRoles = new Map(
    [...text.matchAll(/^<!-- kg:adr-role ([a-z][a-z0-9_]*) -->\r?\n<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)]
      .map((match) => [match[1], match[2]]),
  );
  if (adrRoles.size > 0) {
    for (const role of ["alternatives", "consequences"]) {
      if (!adrRoles.has(role)) throw new Error(`template ${templatePath} is missing ADR role ${role}`);
    }
    if (new Set(adrRoles.values()).size !== adrRoles.size) {
      throw new Error(`template ${templatePath} repeats an ADR role section`);
    }
  }
  return { sections, adrRoles };
}

export function loadTaxonomyAndTemplates(skillRoot) {
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
    const template = host.resolveSafeRelative(skillRoot, record.template_path.slice(prefix.length));
    if (!fs.statSync(template.full).isFile()) throw new Error(`template is not a file: ${record.template_path}`);
    const text = fs.readFileSync(template.full, "utf8");
    const parsed = parseTemplate(text, record.template_path);
    const targetPlaceholders = [...record.create_target_pattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (targetPlaceholders.some((item) => !["slug", "sequence"].includes(item))) {
      throw new Error(`taxonomy ${docType}.create_target_pattern has an unknown placeholder`);
    }
    if (targetPlaceholders.some((item) => targetPlaceholders.filter((value) => value === item).length > 1)) {
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
    templates.set(docType, { ...record, text, targetPlaceholders, ...parsed });
  }
  return { taxonomy, templates };
}

function validateFrontmatter(frontmatter, label) {
  const errors = protocol.validateRecord(frontmatter, protocol.loadProjectDocumentSchema());
  if (errors.length > 0) throw new Error(`${label} frontmatter is invalid: ${errors.join("; ")}`);
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

export function renderBootstrapDocument(plan, document, template, targetPath) {
  const frontmatter = {
    kind: "kg.project_document",
    title: document.title,
    doc_type: document.doc_type,
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: documentSourceRefs(document),
    coverage_limitations: document.coverage_limitations,
  };
  validateFrontmatter(frontmatter, `rendered ${document.doc_type}`);
  const lines = [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${markdownText(document.title)}`,
    "",
    evidenceMarker({
      kind: "kg.bootstrap_document",
      version: 2,
      inventory_sha256: plan.inventory_sha256,
      doc_type: document.doc_type,
      target_path: targetPath,
      coverage_limitations: document.coverage_limitations,
    }),
    "",
  ];
  if (document.coverage_limitations.length > 0) {
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

function exactObjectFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} fields must be ${fields.join(" | ")}`);
}

export function canonicalScaffoldSections(rawSections, template) {
  if (!Array.isArray(rawSections)) throw new Error("sections must be a list");
  const byKey = new Map();
  for (const [index, section] of rawSections.entries()) {
    exactObjectFields(section, ["key", "content"], `sections[${index}]`);
    if (!template.sections.some((item) => item.key === section.key)) {
      throw new Error(`sections[${index}].key is not declared by ${template.template_path}`);
    }
    if (byKey.has(section.key)) throw new Error(`sections[${index}].key is duplicated`);
    const role = [...template.adrRoles].find(([, key]) => key === section.key)?.[0] ?? null;
    let content;
    if (role === "alternatives") {
      if (!Array.isArray(section.content) || section.content.length < 2) {
        throw new Error(`ADR alternatives section ${section.key} needs at least two options`);
      }
      content = section.content.map((item, itemIndex) => {
        exactObjectFields(item, ["option", "tradeoff"], `sections[${index}].content[${itemIndex}]`);
        for (const field of ["option", "tradeoff"]) {
          if (typeof item[field] !== "string" || item[field].trim() === "") {
            throw new Error(`sections[${index}].content[${itemIndex}].${field} must be non-empty`);
          }
        }
        return { option: item.option.trim(), tradeoff: item.tradeoff.trim() };
      });
    } else {
      if (!Array.isArray(section.content) || section.content.length === 0 ||
          !section.content.every((item) => typeof item === "string" && item.trim() !== "")) {
        throw new Error(`section ${section.key} content must be a non-empty string list`);
      }
      content = section.content.map((item) => item.trim());
    }
    byKey.set(section.key, { key: section.key, role, content });
  }
  const expectedKeys = template.sections.map((section) => section.key);
  if (byKey.size !== expectedKeys.length || expectedKeys.some((key) => !byKey.has(key))) {
    throw new Error(`sections must contain every marker from ${template.template_path}`);
  }
  if (template.adrRoles.size > 0) {
    const consequenceKey = template.adrRoles.get("consequences");
    if (byKey.get(consequenceKey)?.content.length < 1) throw new Error("ADR consequences must be non-empty");
  }
  return expectedKeys.map((key) => byKey.get(key));
}

export function renderScaffoldDocument(request, template, targetPath, requestSha256) {
  const frontmatter = {
    kind: "kg.project_document",
    title: request.title,
    doc_type: request.doc_type,
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: request.source_refs,
  };
  validateFrontmatter(frontmatter, `scaffold ${request.doc_type}`);
  const lines = [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${markdownText(request.title)}`,
    "",
    evidenceMarker({
      kind: "kg.scaffold_document",
      version: 1,
      request_sha256: requestSha256,
      doc_type: request.doc_type,
      target_path: targetPath,
      candidate_ref: request.candidate_ref,
      source_refs: request.source_refs,
    }),
    "",
  ];
  for (const sectionTemplate of template.sections) {
    const section = request.sections.find((item) => item.key === sectionTemplate.key);
    lines.push(`<!-- kg:section ${section.key} -->`, `## ${sectionTemplate.heading}`, "");
    if (section.role === "alternatives") {
      for (const item of section.content) lines.push(`- **${markdownText(item.option)}**: ${markdownText(item.tradeoff)}`);
    } else {
      for (const item of section.content) lines.push(`- ${markdownText(item)}`);
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
  if (fs.lstatSync(directory.full).isSymbolicLink()) throw new Error(`taxonomy target parent is a symbolic link: ${directoryRelative}`);
  const matcher = sequencePattern(template);
  return fs.readdirSync(directory.full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => ({ name: entry.name, sequence: Number.parseInt(matcher.exec(entry.name).groups.sequence, 10) }))
    .sort((left, right) => left.sequence - right.sequence);
}

function targetPattern(template) {
  const parts = template.create_target_pattern.split(/(\{sequence\}|\{slug\})/g);
  const expression = parts.map((part) => {
    if (part === "{sequence}") return "(?<sequence>[0-9]{4})";
    if (part === "{slug}") return "(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)";
    return escapeRegex(part);
  }).join("");
  return new RegExp(`^${expression}$`);
}

function validateRequestedTarget(targetPath, slug, template) {
  const match = targetPattern(template).exec(targetPath);
  if (!match) throw new Error(`target does not match taxonomy route: ${targetPath}`);
  if (match.groups?.slug !== undefined && match.groups.slug !== slug) {
    throw new Error(`target slug does not match request slug: ${targetPath}`);
  }
}

export function deriveTarget({ projectRoot, template, slug, requestedMode = null, requestedTargetPath = null, check = false }) {
  const needsSlug = template.targetPlaceholders.includes("slug");
  if (needsSlug) {
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("slug must be lowercase and safe");
  } else if (slug !== null) {
    throw new Error("slug must be null for a fixed taxonomy target");
  }
  let targetPath;
  let mode = requestedMode;
  if (requestedMode === "proposal") {
    if (typeof requestedTargetPath !== "string") throw new Error("proposal target_path is required");
    validateRequestedTarget(requestedTargetPath, slug, template);
    targetPath = requestedTargetPath;
  } else if (template.targetPlaceholders.includes("sequence")) {
    const existing = existingSequenceFiles(projectRoot, template);
    const exact = existing.filter((item) => sequencePattern(template, slug).test(item.name));
    if (requestedMode === null && exact.length === 1) {
      mode = "proposal";
      targetPath = path.posix.join(path.posix.dirname(template.create_target_pattern), exact[0].name);
    } else {
      if (exact.length > 0 && !check) throw new Error(`target for slug already exists: ${slug}`);
      const next = check && exact.length === 1 ? exact[0].sequence : (existing.at(-1)?.sequence ?? 0) + 1;
      if (next > 9999) throw new Error("document sequence is exhausted");
      targetPath = template.create_target_pattern
        .replace("{sequence}", String(next).padStart(4, "0"))
        .replace("{slug}", slug);
      mode ??= "create";
    }
  } else {
    targetPath = template.create_target_pattern.replace("{slug}", slug ?? "");
    if (requestedMode === null) mode = fs.existsSync(path.join(projectRoot, targetPath)) ? "proposal" : "create";
  }
  if (!["create", "proposal"].includes(mode)) throw new Error(`invalid target mode: ${mode}`);
  const resolved = host.resolveSafeRelative(projectRoot, targetPath, { mustExist: check || mode === "proposal" });
  return { targetPath, target: resolved.full, mode };
}

export function preflightPathSegments(projectRoot, relative, label) {
  let current = projectRoot;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link: ${relative}`);
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error(`${label} parent is not a directory: ${relative}`);
  }
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function prepareProposal({ projectRoot, prefix, kind, route, candidateText, identity, sourceRefs }) {
  const targetBuffer = fs.readFileSync(route.target);
  const candidateBuffer = Buffer.from(candidateText, "utf8");
  const targetSha256 = sha256Hex(targetBuffer);
  const candidateSha256 = sha256Hex(candidateBuffer);
  const contentId = repository.canonicalDigest({
    target_path: route.targetPath,
    target_sha256: targetSha256,
    candidate_sha256: candidateSha256,
    ...identity,
  });
  const proposalId = `${prefix}-${contentId}`;
  const bundlePath = `docs/proposals/${proposalId}`;
  const candidatePath = `${bundlePath}/candidate.md`;
  const manifestPath = `${bundlePath}/manifest.json`;
  const value = {
    kind,
    version: 1,
    proposal_id: proposalId,
    doc_type: route.docType,
    target_path: route.targetPath,
    target_sha256: targetSha256,
    candidate_path: candidatePath,
    candidate_sha256: candidateSha256,
    ...identity,
    source_refs: sourceRefs,
    status: "proposed",
  };
  return {
    proposalId,
    bundlePath,
    bundle: host.resolveSafeRelative(projectRoot, bundlePath, { mustExist: false }).full,
    candidatePath,
    candidate: host.resolveSafeRelative(projectRoot, candidatePath, { mustExist: false }).full,
    candidateText,
    manifestPath,
    manifest: host.resolveSafeRelative(projectRoot, manifestPath, { mustExist: false }).full,
    manifestText: `${JSON.stringify(value, null, 2)}\n`,
    value,
    reused: false,
  };
}

export function preflightProposal(projectRoot, proposal) {
  preflightPathSegments(projectRoot, proposal.candidatePath, "proposal candidate");
  preflightPathSegments(projectRoot, proposal.manifestPath, "proposal manifest");
  if (!fs.existsSync(proposal.bundle)) return;
  if (fs.lstatSync(proposal.bundle).isSymbolicLink() || !fs.statSync(proposal.bundle).isDirectory()) {
    throw new Error(`proposal bundle path is unsafe: ${proposal.bundlePath}`);
  }
  for (const [label, file, expected] of [
    ["candidate", proposal.candidate, proposal.candidateText],
    ["manifest", proposal.manifest, proposal.manifestText],
  ]) {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
      throw new Error(`existing proposal ${label} is missing or unsafe: ${proposal.bundlePath}`);
    }
    if (fs.readFileSync(file, "utf8") !== expected) {
      throw new Error(`existing proposal ${label} does not match content address: ${proposal.bundlePath}`);
    }
  }
  proposal.reused = true;
}

export function ensureDirectory(directory, projectRoot, createdDirectories) {
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

export function writeExclusive(file, content, createdFiles) {
  const descriptor = fs.openSync(file, "wx");
  createdFiles.push(file);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function rollbackWrites(createdFiles, createdDirectories) {
  for (const file of [...createdFiles].reverse()) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Preserve the original error. A later check exposes residue.
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
