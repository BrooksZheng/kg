#!/usr/bin/env node

// Validate an agent-authored JSON bootstrap plan against one static inventory
// and render docs/architecture/overview.md.

import fs from "node:fs";
import path from "node:path";
import { host, kyaml, protocol, repository } from "./_lib.mjs";

const TARGET = "docs/architecture/overview.md";
const PLAN_FIELDS = [
  "kind",
  "version",
  "title",
  "coverage_limitations",
  "observed_facts",
  "inferences",
];
const FACT_FIELDS = ["section", "statement", "source"];
const INFERENCE_FIELDS = ["section", "statement", "confidence", "sources"];
const SECTIONS = new Map([
  ["context", "上下文与边界（C4 System Context）"],
  ["building_blocks", "构建块视图（C4 Container）"],
  ["runtime", "运行时视图"],
  ["deployment", "部署视图"],
]);

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
  if (host.hasPathSegment(file, ".kg")) throw new Error(`${label} must not be inside .kg`);
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

function section(value, label) {
  if (!SECTIONS.has(value)) throw new Error(`${label} must be one of: ${[...SECTIONS.keys()].join(" | ")}`);
  return value;
}

function canonicalPlan(raw, inventory, inventoryState) {
  rejectUnknown(raw, PLAN_FIELDS, "plan");
  if (raw.kind !== "kg.docs_bootstrap_plan" || raw.version !== 1) {
    throw new Error("plan kind or version is invalid");
  }
  const coverageLimitations = stringList(raw.coverage_limitations, "plan.coverage_limitations");
  if (inventory.truncated && coverageLimitations.length === 0) {
    throw new Error("truncated inventory requires at least one coverage limitation");
  }
  if (!Array.isArray(raw.observed_facts) || raw.observed_facts.length === 0) {
    throw new Error("plan.observed_facts must be a non-empty list");
  }
  if (!Array.isArray(raw.inferences)) throw new Error("plan.inferences must be a list");

  const observedFacts = raw.observed_facts.map((item, index) => {
    rejectUnknown(item, FACT_FIELDS, `plan.observed_facts[${index}]`);
    return {
      section: section(item.section, `plan.observed_facts[${index}].section`),
      statement: nonEmptyString(item.statement, `plan.observed_facts[${index}].statement`),
      source: repository.validateInventorySource(item.source, inventoryState),
    };
  });
  const inferences = raw.inferences.map((item, index) => {
    rejectUnknown(item, INFERENCE_FIELDS, `plan.inferences[${index}]`);
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

function sourceReference(source) {
  const suffix = source.line_start === source.line_end
    ? `#L${source.line_start}`
    : `#L${source.line_start}-L${source.line_end}`;
  return `${source.path}${suffix}`;
}

function markdownText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderDocument(plan) {
  const sourceRefs = [];
  for (const fact of plan.observed_facts) sourceRefs.push(sourceReference(fact.source));
  for (const inference of plan.inferences) {
    for (const source of inference.sources) sourceRefs.push(sourceReference(source));
  }
  const frontmatter = {
    kind: "kg.project_document",
    title: plan.title,
    doc_type: "architecture",
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: [...new Set(sourceRefs)],
  };
  const frontmatterErrors = protocol.validateRecord(frontmatter, protocol.loadProjectDocumentSchema());
  if (frontmatterErrors.length) throw new Error(`rendered frontmatter is invalid: ${frontmatterErrors.join("; ")}`);

  const lines = [
    "---",
    kyaml.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${markdownText(plan.title)}`,
    "",
  ];
  if (plan.coverage_limitations.length) {
    lines.push("## 覆盖限制", "", ...plan.coverage_limitations.map((item) => `- ${markdownText(item)}`), "");
  }
  for (const [sectionKey, heading] of SECTIONS) {
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
      lines.push(
        `- **推断（confidence ${inference.confidence.toFixed(2)}）**：${markdownText(inference.statement)}（证据：${refs}）`,
      );
    }
    if (facts.length === 0 && inferences.length === 0) lines.push("- 暂无经证据绑定的内容。");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function cleanupCreatedDirectories(created) {
  for (const directory of created.reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // A non-empty or concurrently used directory is left intact.
    }
  }
}

const args = parseArgs(process.argv.slice(2));
let projectRoot, inventory, plan, target, expected;
try {
  projectRoot = host.assertSafeHostRoot(args.project_root);
  inventory = readJsonFile(args.inventory, "inventory").value;
  const inventoryState = repository.validateRepositoryInventory(inventory, projectRoot);
  plan = canonicalPlan(readJsonFile(args.plan, "plan").value, inventory, inventoryState);
  target = host.resolveSafeRelative(projectRoot, TARGET, { mustExist: false }).full;
  expected = renderDocument(plan);
} catch (error) {
  host.fail(error.message);
}

if (args.check) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) host.fail(`bootstrap target does not exist: ${TARGET}`);
  if (fs.readFileSync(target, "utf8") !== expected) host.fail(`bootstrap target does not match validated plan: ${TARGET}`);
  console.log(`kg: bootstrap document matches inventory and plan: ${TARGET}`);
  process.exit(0);
}

if (fs.existsSync(target)) host.fail(`bootstrap target already exists: ${TARGET}; proposal mode belongs to M3`);

const parent = path.dirname(target);
const createdDirectories = [];
let current = parent;
while (!fs.existsSync(current)) {
  createdDirectories.unshift(current);
  current = path.dirname(current);
}
let targetCreated = false;
try {
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(target, expected, { flag: "wx" });
  targetCreated = true;
} catch (error) {
  if (targetCreated) fs.rmSync(target, { force: true });
  cleanupCreatedDirectories(createdDirectories);
  throw error;
}
console.log(`kg: created ${TARGET} from ${plan.observed_facts.length} observed fact(s) and ${plan.inferences.length} inference(s)`);
