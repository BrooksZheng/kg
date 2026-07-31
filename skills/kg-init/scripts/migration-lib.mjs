import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { kyaml, host } from "./_lib.mjs";

export const SKILL_NAMES = [
  "kg-init",
  "kg-observe",
  "kg-compile",
  "kg-scan",
  "kg-kickoff",
  "kg-spec",
  "kg-docs",
];

const V1_SKILL_NAMES = new Set(["kg-init", "kg-observe", "kg-compile", "kg-scan"]);
const V2_SKILL_REQUIRED_CLI = {
  "kg-init": "scripts/migrate-v1.mjs",
  "kg-observe": "scripts/add-observation.mjs",
  "kg-compile": "scripts/archive-observations.mjs",
  "kg-scan": "scripts/scan-inventory.mjs",
  "kg-kickoff": "scripts/gather-context.mjs",
  "kg-spec": "scripts/produce-spec.mjs",
  "kg-docs": "scripts/inventory.mjs",
};
const V2_CONFIG_KEYS = ["kind", "version", "observation_threshold", "skills_path"];
const V1_CONFIG_KEYS = ["observation_threshold", "agents_block_budget_lines", "skills_path"];
const QUEUE_CATEGORIES = new Set([
  "needs_human_decision",
  "project_knowledge",
  "procedure",
  "project_contract",
  "executable_constraint",
]);
const V2_DIRECTORIES = [
  ".kg/migration",
  "docs/specs",
  "docs/architecture",
  "docs/decisions",
  "docs/rfcs",
  "docs/api",
  "docs/standards",
  "docs/runbooks",
  "docs/traps",
  "docs/domain",
  "docs/proposals",
  "harness/artifacts",
  "harness/skills",
  "harness/scripts",
];
const LAZY_CONTENT_FILES = [
  "docs/glossary.md",
  "docs/development.md",
  "docs/architecture/overview.md",
  "docs/decisions/0000-template.md",
  "docs/rfcs/0000-template.md",
];

const BEGIN_MARKER = "<!-- kg:begin -->";
const END_MARKER = "<!-- kg:end -->";
const HARD_RULE =
  "- 禁止读取 `.kg/`：这里存放未经编译的 claim 与管道状态；写入只经 `kg-observe`，读取只发生在 `kg-compile` 会话。";
const HARD_BLOCK = `## 硬规则\n\n${HARD_RULE}`;
const COMMANDS_BLOCK = [
  "## Commands",
  "",
  "```bash",
  "# 构建",
  "<YOUR_BUILD_COMMAND>",
  "# 测试",
  "<YOUR_TEST_COMMAND>",
  "# Lint",
  "<YOUR_LINT_COMMAND>",
  "```",
].join("\n");
const USAGE_BLOCK = [
  "## 使用 kg",
  "",
  "- `kg-kickoff`：任务开始时逐项澄清约束。",
  "- `kg-spec`：共识形成后固化 task spec。",
  "- `kg-observe`：任务中记录可复用信号。",
].join("\n");

export class MigrationError extends Error {}

export class QueueMigrationError extends MigrationError {
  constructor(items) {
    super("queue contains items that M2 cannot map");
    this.items = items;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sameFingerprint(left, right) {
  return stableJson(left) === stableJson(right);
}

function relativePortable(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationError(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableJson(actual) !== stableJson(wanted)) {
    throw new MigrationError(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function fingerprintDirectory(directory) {
  const entries = [];

  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({ path: rel, type: "symlink", target: fs.readlinkSync(full) });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, type: "directory" });
        walk(full, rel);
      } else if (stat.isFile()) {
        const content = fs.readFileSync(full);
        entries.push({ path: rel, type: "file", size: content.length, sha256: sha256(content) });
      } else {
        entries.push({ path: rel, type: "other" });
      }
    }
  }

  walk(directory, "");
  return {
    type: "directory",
    entries: entries.length,
    sha256: sha256(Buffer.from(stableJson(entries))),
  };
}

export function fingerprintPath(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { type: "missing" };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const targetText = fs.readlinkSync(target);
    return {
      type: "symlink",
      target: targetText,
      sha256: sha256(Buffer.from(targetText)),
    };
  }
  if (stat.isDirectory()) return fingerprintDirectory(target);
  if (stat.isFile()) {
    const content = fs.readFileSync(target);
    return {
      type: "file",
      size: content.length,
      sha256: sha256(content),
    };
  }
  return { type: "other" };
}

function fingerprintBytes(content) {
  return {
    type: "file",
    size: content.length,
    sha256: sha256(content),
  };
}

function countToken(text, token) {
  let count = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(token, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + token.length;
  }
  return count;
}

function markerLine(text, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`^${escaped}\\r?(?:\\n|$)`, "gm"))];
}

function sectionMatches(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`^## ${escaped}[ \\t]*\\r?$`, "gm"))];
}

function extractSection(text, match) {
  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const next = /\n## [^\n]+\r?(?:\n|$)/.exec(rest);
  return next ? text.slice(start, start + match[0].length + next.index) : text.slice(start);
}

function validateCommandsSection(text, { injected }) {
  const headings = sectionMatches(text, "Commands");
  if (headings.length !== 1) {
    throw new MigrationError(`AGENTS.md must contain exactly one Commands section; found ${headings.length}`);
  }
  const section = extractSection(text, headings[0]);
  const bashBlocks = [...section.matchAll(/^```bash[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (bashBlocks.length !== 1) {
    throw new MigrationError("AGENTS.md Commands section must contain exactly one bash code block");
  }
  const commentLines = bashBlocks[0][1]
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith("#"));
  if (commentLines.length < 3) {
    throw new MigrationError("AGENTS.md Commands bash block must contain at least three comment lines");
  }
  const labels = commentLines.map((line) => line.trimStart().slice(1).trim().toLowerCase());
  const requiredLabels = [
    { name: "build", present: labels.some((label) => label === "build" || label === "构建") },
    { name: "test", present: labels.some((label) => label === "test" || label.startsWith("测试")) },
    { name: "lint", present: labels.some((label) => label === "lint") },
  ];
  const missingLabels = requiredLabels.filter((label) => !label.present).map((label) => label.name);
  if (missingLabels.length) {
    throw new MigrationError(`AGENTS.md Commands comments are missing labels: ${missingLabels.join(", ")}`);
  }
  if (injected) {
    for (const placeholder of ["<YOUR_BUILD_COMMAND>", "<YOUR_TEST_COMMAND>", "<YOUR_LINT_COMMAND>"]) {
      if (countToken(bashBlocks[0][1], placeholder) !== 1) {
        throw new MigrationError(`AGENTS.md injected Commands section must contain ${placeholder} exactly once`);
      }
    }
  }
}

export function lineCount(text) {
  if (text === "") return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function validateAgentsV2(text, { injectedCommands = false } = {}) {
  if (countToken(text, BEGIN_MARKER) !== 0 || countToken(text, END_MARKER) !== 0) {
    throw new MigrationError("AGENTS.md still contains v1 managed markers");
  }
  if (sectionMatches(text, "硬规则").length !== 1) {
    throw new MigrationError("AGENTS.md must contain exactly one 硬规则 section");
  }
  if (countToken(text, HARD_RULE) !== 1) {
    throw new MigrationError("AGENTS.md must contain the .kg isolation rule exactly once");
  }
  validateCommandsSection(text, { injected: injectedCommands });
  if (sectionMatches(text, "使用 kg").length !== 1) {
    throw new MigrationError("AGENTS.md must contain exactly one 使用 kg section");
  }
  const usageSection = extractSection(text, sectionMatches(text, "使用 kg")[0]);
  for (const skill of ["kg-kickoff", "kg-spec", "kg-observe"]) {
    if (countToken(usageSection, `\`${skill}\``) !== 1) {
      throw new MigrationError(`AGENTS.md 使用 kg section must mention ${skill} exactly once`);
    }
  }
}

export function migrateAgentsText(original) {
  if (countToken(original, BEGIN_MARKER) !== 1 || countToken(original, END_MARKER) !== 1) {
    throw new MigrationError("AGENTS.md must contain exactly one complete v1 managed marker pair");
  }
  const begins = markerLine(original, BEGIN_MARKER);
  const ends = markerLine(original, END_MARKER);
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index) {
    throw new MigrationError("AGENTS.md managed markers are malformed or nested");
  }

  const before = original.slice(0, begins[0].index);
  const after = original.slice(ends[0].index + ends[0][0].length);
  let manual = `${before}${after}`;

  const hardHeadings = sectionMatches(manual, "硬规则");
  if (hardHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human 硬规则 sections");
  if (hardHeadings.length === 1 && countToken(manual, HARD_RULE) !== 1) {
    throw new MigrationError("existing human 硬规则 section does not contain the v2 isolation rule");
  }

  const commandHeadings = sectionMatches(manual, "Commands");
  if (commandHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human Commands sections");
  const injectedCommands = commandHeadings.length === 0;
  if (!injectedCommands) validateCommandsSection(manual, { injected: false });

  const usageHeadings = sectionMatches(manual, "使用 kg");
  if (usageHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human 使用 kg sections");
  if (usageHeadings.length === 1) {
    for (const skill of ["kg-kickoff", "kg-spec", "kg-observe"]) {
      if (countToken(extractSection(manual, usageHeadings[0]), `\`${skill}\``) !== 1) {
        throw new MigrationError(`existing human 使用 kg section does not mention ${skill} exactly once`);
      }
    }
  }

  const missingHard = hardHeadings.length === 0;
  const missingUsage = usageHeadings.length === 0;
  const separator = (value) => (value === "" || value.endsWith("\n\n") ? "" : value.endsWith("\n") ? "\n" : "\n\n");

  if (injectedCommands) {
    const additions = [
      ...(missingHard ? [HARD_BLOCK] : []),
      COMMANDS_BLOCK,
      ...(missingUsage ? [USAGE_BLOCK] : []),
    ];
    manual = `${manual}${separator(manual)}${additions.join("\n\n")}\n`;
  } else {
    if (missingHard) {
      const commandIndex = commandHeadings[0].index;
      const prefix = manual.slice(0, commandIndex);
      const suffix = manual.slice(commandIndex);
      manual = `${prefix}${separator(prefix)}${HARD_BLOCK}\n\n${suffix}`;
    }
    if (missingUsage) manual = `${manual}${separator(manual)}${USAGE_BLOCK}\n`;
  }

  validateAgentsV2(manual, { injectedCommands });
  return {
    text: manual,
    before,
    after,
    injected_commands: injectedCommands,
    line_count: lineCount(manual),
  };
}

function insertAtSectionEnd(text, heading, addition) {
  const matches = sectionMatches(text, heading);
  if (matches.length !== 1) throw new MigrationError(`AGENTS.md must contain exactly one ${heading} section`);
  const start = matches[0].index + matches[0][0].length;
  const rest = text.slice(start);
  const next = /\n## [^\n]+\r?(?:\n|$)/.exec(rest);
  const end = next ? start + next.index : text.length;
  const section = text.slice(matches[0].index, end);
  const separator = section.endsWith("\n\n") ? "" : section.endsWith("\n") ? "\n" : "\n\n";
  return `${text.slice(0, end)}${separator}${addition}\n${text.slice(end)}`;
}

function appendBlock(text, block) {
  const separator = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

export function ensureAgentsV2Text(original) {
  if (typeof original !== "string") throw new MigrationError("AGENTS.md content must be a string");
  if (original.includes(BEGIN_MARKER) || original.includes(END_MARKER)) {
    throw new MigrationError("AGENTS.md contains v1 managed markers and requires migration Phase 0");
  }
  let text = original;

  const hardHeadings = sectionMatches(text, "硬规则");
  if (hardHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human 硬规则 sections");
  if (hardHeadings.length === 0) {
    const commands = sectionMatches(text, "Commands");
    if (commands.length > 1) throw new MigrationError("AGENTS.md has multiple human Commands sections");
    if (commands.length === 1) {
      const index = commands[0].index;
      const prefix = text.slice(0, index);
      const separator = prefix === "" || prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
      text = `${prefix}${separator}${HARD_BLOCK}\n\n${text.slice(index)}`;
    } else {
      text = appendBlock(text, HARD_BLOCK);
    }
  } else {
    const hardSection = extractSection(text, hardHeadings[0]);
    const occurrences = countToken(hardSection, HARD_RULE);
    if (occurrences > 1) throw new MigrationError("AGENTS.md hard rule appears more than once");
    if (occurrences === 0) text = insertAtSectionEnd(text, "硬规则", HARD_RULE);
  }

  const commandHeadings = sectionMatches(text, "Commands");
  if (commandHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human Commands sections");
  const injectedCommands = commandHeadings.length === 0;
  if (injectedCommands) text = appendBlock(text, COMMANDS_BLOCK);
  else validateCommandsSection(text, { injected: false });

  const usageHeadings = sectionMatches(text, "使用 kg");
  if (usageHeadings.length > 1) throw new MigrationError("AGENTS.md has multiple human 使用 kg sections");
  if (usageHeadings.length === 0) {
    text = appendBlock(text, USAGE_BLOCK);
  } else {
    for (const skill of ["kg-kickoff", "kg-spec", "kg-observe"]) {
      const section = extractSection(text, sectionMatches(text, "使用 kg")[0]);
      const occurrences = countToken(section, `\`${skill}\``);
      if (occurrences > 1) throw new MigrationError(`AGENTS.md 使用 kg section mentions ${skill} more than once`);
      if (occurrences === 0) text = insertAtSectionEnd(text, "使用 kg", `- \`${skill}\``);
    }
  }

  validateAgentsV2(text, { injectedCommands });
  return { text, injected_commands: injectedCommands, line_count: lineCount(text) };
}

function parseConfig(file) {
  let value;
  try {
    value = kyaml.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new MigrationError(`config is not valid KYAML: ${error.message}`);
  }
  assertPlainObject(value, "config");
  return value;
}

function exactKeySet(value, expected) {
  return stableJson(Object.keys(value).sort()) === stableJson([...expected].sort());
}

function validThreshold(value) {
  return Number.isInteger(value) && value > 0;
}

function validSkillsPath(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isValidV1Config(config) {
  return (
    exactKeySet(config, V1_CONFIG_KEYS) &&
    config.kind === undefined &&
    config.version === undefined &&
    validThreshold(config.observation_threshold) &&
    Number.isInteger(config.agents_block_budget_lines) &&
    config.agents_block_budget_lines > 0 &&
    validSkillsPath(config.skills_path)
  );
}

function isValidV2Config(config) {
  return (
    exactKeySet(config, V2_CONFIG_KEYS) &&
    config.kind === "kg.config" &&
    config.version === 2 &&
    validThreshold(config.observation_threshold) &&
    validSkillsPath(config.skills_path)
  );
}

function regularFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function directory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listKgSkills(root, platform) {
  const skills = path.join(root, platform, "skills");
  if (!directory(skills)) return [];
  return fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith("kg-"))
    .map((entry) => entry.name)
    .sort();
}

function hasCompleteV1Markers(text) {
  const begins = markerLine(text, BEGIN_MARKER);
  const ends = markerLine(text, END_MARKER);
  return begins.length === 1 && ends.length === 1 && begins[0].index < ends[0].index;
}

function safeProjectInventory(root) {
  const excludedDirectories = new Set([
    ".git",
    ".kg",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    "secrets",
    "credentials",
  ]);
  const sensitiveFiles = [/^\.env(?:\.|$)/i, /^\.npmrc$/i, /\.(?:pem|key|p12|pfx)$/i];
  const manifests = new Set([
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
  ]);
  const sourceExtensions = new Set([".c", ".cc", ".cpp", ".go", ".java", ".js", ".jsx", ".mjs", ".py", ".rs", ".swift", ".ts", ".tsx"]);
  let count = 0;
  let bootstrap = false;

  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) walk(path.join(current, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile() || sensitiveFiles.some((pattern) => pattern.test(entry.name))) continue;
      count += 1;
      const first = relativePath.split("/")[0];
      if (
        manifests.has(entry.name) ||
        ["src", "app", "lib"].includes(first) ||
        sourceExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        bootstrap = true;
      }
    }
  }

  walk(root, "");
  return { count, bootstrap };
}

function detectionSignal(signals, code, relative) {
  signals.push({ code, path: relative, observed: true });
}

function detectionProblem(problems, code, relative, severity, recoverability) {
  problems.push({ code, path: relative, severity, recoverability });
}

function hasUnresolvedMigrationState(root, signals, problems) {
  const candidates = [
    [".kg/migration/active-plan.json", "active_migration_plan_present"],
    [".kg/migration/stage", "migration_stage_present"],
    [".kg/migration/quarantine", "migration_quarantine_present"],
  ];
  let unresolved = false;
  for (const [relative, code] of candidates) {
    const target = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(target)) continue;
    if (directory(target) && fs.readdirSync(target).length === 0) continue;
    unresolved = true;
    detectionSignal(signals, code, relative);
    detectionProblem(problems, "UNRESOLVED_MIGRATION_STATE", relative, "error", "human");
  }
  if (fs.existsSync(path.join(root, ".kg", "config.v1.bak"))) {
    detectionSignal(signals, "migration_backup_present", ".kg/config.v1.bak");
  }
  return unresolved;
}

function v2SkillProblems(root, names, problems) {
  const actual = new Set(names);
  const expected = new Set(SKILL_NAMES);
  for (const name of SKILL_NAMES) {
    const skillRoot = path.join(root, ".agents", "skills", name);
    if (!actual.has(name)) {
      detectionProblem(problems, "V2_SKILL_MISSING", `.agents/skills/${name}`, "error", "automatic");
      continue;
    }
    for (const required of ["SKILL.md", "scripts/lib", "protocol", V2_SKILL_REQUIRED_CLI[name]]) {
      const target = path.join(skillRoot, ...required.split("/"));
      const valid = required === "scripts/lib" || required === "protocol" ? directory(target) : regularFile(target);
      if (!valid) {
        detectionProblem(
          problems,
          "V2_SKILL_NOT_SELF_CONTAINED",
          `.agents/skills/${name}/${required}`,
          "error",
          "automatic",
        );
      }
    }
  }
  for (const name of names.filter((candidate) => !expected.has(candidate))) {
    detectionProblem(problems, "UNKNOWN_KG_SKILL", `.agents/skills/${name}`, "error", "human");
  }
}

function claudeWiringProblems(root, names, problems) {
  const claudeMarker = fs.existsSync(path.join(root, ".claude")) || fs.existsSync(path.join(root, "CLAUDE.md"));
  if (!claudeMarker) return;
  const claudeText = regularFile(path.join(root, "CLAUDE.md"))
    ? fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")
    : "";
  if (!/^@AGENTS\.md[ \t]*$/m.test(claudeText)) {
    detectionProblem(problems, "CLAUDE_AGENTS_IMPORT_INVALID", "CLAUDE.md", "error", "automatic");
  }
  for (const name of names) {
    const link = path.join(root, ".claude", "skills", name);
    const agentSkill = path.join(root, ".agents", "skills", name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink() || host.canonicalPath(link) !== host.canonicalPath(agentSkill)) {
        throw new Error("invalid wiring");
      }
    } catch {
      detectionProblem(problems, "CLAUDE_SKILL_WIRING_INVALID", `.claude/skills/${name}`, "error", "automatic");
    }
  }
}

export function detectMigration(rootValue) {
  const root = host.normalizeRoot(rootValue);
  const canonical = root.canonical;
  const signals = [];
  const problems = [];
  const configFile = path.join(canonical, ".kg", "config.yaml");
  const agentsFile = path.join(canonical, "AGENTS.md");
  const agentSkills = listKgSkills(canonical, ".agents");
  const claudeSkills = listKgSkills(canonical, ".claude");
  let config = null;
  let configCandidate = null;

  const kgRootEntries = fs
    .readdirSync(canonical, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase() === ".kg");
  const safeKgState = kgRootEntries.some((entry) => entry.name === ".kg" && entry.isDirectory());
  for (const entry of kgRootEntries) {
    if (entry.name === ".kg") {
      detectionSignal(signals, "kg_state_directory_present", ".kg");
    } else {
      detectionSignal(signals, "mixed_case_kg_state_directory_present", entry.name);
      detectionProblem(problems, "MIXED_CASE_KG_PATH", entry.name, "error", "human");
    }
    if (entry.isSymbolicLink()) {
      detectionProblem(problems, "KG_STATE_PATH_SYMLINK", entry.name, "error", "human");
    }
  }
  if (safeKgState && fs.existsSync(configFile)) {
    detectionSignal(signals, "config_present", ".kg/config.yaml");
    try {
      config = parseConfig(configFile);
      if (config.kind === "kg.config" || config.version !== undefined) configCandidate = "v2";
      else if (Object.prototype.hasOwnProperty.call(config, "agents_block_budget_lines")) configCandidate = "v1";
      else configCandidate = "unknown";
      detectionSignal(signals, `${configCandidate}_config_shape_present`, ".kg/config.yaml");
    } catch {
      detectionProblem(problems, "CONFIG_INVALID_KYAML", ".kg/config.yaml", "error", "human");
    }
  }
  if (agentSkills.length > 0) detectionSignal(signals, "agents_kg_skills_present", ".agents/skills");
  if (claudeSkills.length > 0) detectionSignal(signals, "claude_kg_skills_present", ".claude/skills");
  const knowledgePath = path.join(canonical, "knowledge");
  if (fs.existsSync(knowledgePath) && fs.lstatSync(knowledgePath).isSymbolicLink()) {
    detectionSignal(signals, "knowledge_path_symlink_present", "knowledge");
    detectionProblem(problems, "KNOWLEDGE_PATH_SYMLINK", "knowledge", "error", "human");
  } else if (directory(knowledgePath)) {
    const entries = fs.readdirSync(knowledgePath).filter((name) => /^KN-.*\.md$/.test(name));
    if (entries.length > 0) detectionSignal(signals, "knowledge_entries_present", "knowledge");
  }
  let agentsText = null;
  if (regularFile(agentsFile)) {
    agentsText = fs.readFileSync(agentsFile, "utf8");
    if (agentsText.includes(BEGIN_MARKER) || agentsText.includes(END_MARKER)) {
      detectionSignal(signals, "agents_v1_marker_present", "AGENTS.md");
    }
  }
  const cursorignore = path.join(canonical, ".cursorignore");
  if (regularFile(cursorignore) && fs.readFileSync(cursorignore, "utf8").split(/\r?\n/).some((line) => line.trim() === ".kg/")) {
    detectionSignal(signals, "kg_ignore_rule_present", ".cursorignore");
  }
  const unresolvedMigration = safeKgState ? hasUnresolvedMigrationState(canonical, signals, problems) : false;

  const hasKgSignal = signals.length > 0 || problems.some((problem) => problem.code === "CONFIG_INVALID_KYAML");
  let healthyV1 = false;
  let healthyV2 = false;

  if (config && configCandidate === "v1") {
    if (!isValidV1Config(config)) {
      detectionProblem(problems, "V1_CONFIG_INVALID", ".kg/config.yaml", "error", "human");
    }
    for (const relative of [
      ".kg/observations",
      ".kg/observations/processed",
      ".kg/queue",
      ".kg/reports",
      "knowledge",
      ".agents/skills",
    ]) {
      if (!directory(path.join(canonical, ...relative.split("/")))) {
        detectionProblem(problems, "V1_CORE_DIRECTORY_MISSING", relative, "error", "automatic");
      }
    }
    if (agentsText === null || !hasCompleteV1Markers(agentsText)) {
      detectionProblem(problems, "V1_MANAGED_MARKERS_INVALID", "AGENTS.md", "error", "human");
    }
    const actual = new Set(agentSkills);
    for (const name of V1_SKILL_NAMES) {
      if (!actual.has(name)) {
        detectionProblem(problems, "V1_SKILL_MISSING", `.agents/skills/${name}`, "error", "automatic");
      }
    }
    const platformSkills = [...new Set([...agentSkills, ...claudeSkills])].sort();
    const v2Only = platformSkills.filter((name) => SKILL_NAMES.includes(name) && !V1_SKILL_NAMES.has(name));
    if (v2Only.length > 0) {
      for (const name of v2Only) {
        const platform = agentSkills.includes(name) ? ".agents" : ".claude";
        detectionProblem(problems, "MIXED_KG_SKILL_GENERATIONS", `${platform}/skills/${name}`, "error", "human");
      }
    }
    for (const name of platformSkills.filter((candidate) => !SKILL_NAMES.includes(candidate))) {
      const platform = agentSkills.includes(name) ? ".agents" : ".claude";
      detectionProblem(problems, "UNKNOWN_KG_SKILL", `${platform}/skills/${name}`, "error", "human");
    }
    healthyV1 = isValidV1Config(config) && problems.length === 0 && !unresolvedMigration;
  } else if (config && configCandidate === "v2") {
    if (!isValidV2Config(config)) {
      detectionProblem(problems, "V2_CONFIG_INVALID", ".kg/config.yaml", "error", "human");
    }
    v2SkillProblems(canonical, agentSkills, problems);
    if (agentsText === null) {
      detectionProblem(problems, "V2_AGENTS_INVALID", "AGENTS.md", "error", "automatic");
    } else {
      try {
        validateAgentsV2(agentsText);
      } catch {
        detectionProblem(problems, "V2_AGENTS_INVALID", "AGENTS.md", "error", "human");
      }
    }
    claudeWiringProblems(canonical, SKILL_NAMES, problems);
    for (const name of claudeSkills.filter((candidate) => !SKILL_NAMES.includes(candidate))) {
      detectionProblem(problems, "UNKNOWN_KG_SKILL", `.claude/skills/${name}`, "error", "human");
    }
    healthyV2 = isValidV2Config(config) && problems.length === 0 && !unresolvedMigration;
  } else if (hasKgSignal && !problems.some((problem) => problem.code === "CONFIG_INVALID_KYAML")) {
    detectionProblem(problems, "CONFIG_MISSING_OR_UNCLASSIFIED", ".kg/config.yaml", "error", "human");
  }

  let classification;
  let specScenario;
  let condition;
  let allowedActions;
  let requiresHuman;
  let bootstrapRecommended = false;
  if (healthyV2) {
    classification = "v2";
    specScenario = "v2";
    condition = "healthy";
    allowedActions = ["verify"];
    requiresHuman = false;
  } else if (healthyV1) {
    classification = "v1";
    specScenario = "v1";
    condition = "healthy";
    allowedActions = ["migrate"];
    requiresHuman = false;
  } else if (hasKgSignal) {
    const ambiguousCodes = new Set([
      "MIXED_KG_SKILL_GENERATIONS",
      "MIXED_CASE_KG_PATH",
      "UNKNOWN_KG_SKILL",
      "UNRESOLVED_MIGRATION_STATE",
      "KG_STATE_PATH_SYMLINK",
      "KNOWLEDGE_PATH_SYMLINK",
    ]);
    const brokenCodes = new Set([
      "CONFIG_INVALID_KYAML",
      "V1_CONFIG_INVALID",
      "V2_CONFIG_INVALID",
      "V1_MANAGED_MARKERS_INVALID",
      "V2_AGENTS_INVALID",
    ]);
    classification = "partial_broken";
    condition = problems.some((problem) => ambiguousCodes.has(problem.code))
      ? "ambiguous"
      : problems.some((problem) => brokenCodes.has(problem.code))
        ? "broken"
        : "partial";
    specScenario = condition === "ambiguous" ? "ambiguous" : "partial";
    requiresHuman = problems.some((problem) => problem.recoverability === "human");
    allowedActions = requiresHuman
      ? ["request_human"]
      : unresolvedMigration
        ? ["repair", "resume"]
        : ["repair"];
  } else {
    const inventory = safeProjectInventory(canonical);
    classification = inventory.count === 0 ? "greenfield" : "non_kg_host";
    specScenario = inventory.count === 0 ? "fresh" : "brownfield";
    condition = "healthy";
    allowedActions = ["install"];
    requiresHuman = false;
    bootstrapRecommended = inventory.count > 0 && inventory.bootstrap;
    if (inventory.count > 0) detectionSignal(signals, "safe_project_content_present", ".");
  }

  signals.sort((left, right) => `${left.code}\0${left.path}`.localeCompare(`${right.code}\0${right.path}`));
  problems.sort((left, right) => `${left.code}\0${left.path}`.localeCompare(`${right.code}\0${right.path}`));
  return {
    kind: "kg.migration_detection",
    version: 2,
    root,
    classification,
    spec_scenario: specScenario,
    condition,
    signals,
    problems,
    allowed_actions: allowedActions,
    requires_human: requiresHuman,
    bootstrap_recommended: bootstrapRecommended,
  };
}

function assertHealthyV1(detection, config) {
  if (detection.classification !== "v1") {
    throw new MigrationError(`M2 migration requires a healthy v1 host; detected ${detection.classification}`);
  }
  assertExactKeys(config, V1_CONFIG_KEYS, "v1 config");
  if (!Number.isInteger(config.observation_threshold) || config.observation_threshold <= 0) {
    throw new MigrationError("v1 observation_threshold must be a positive integer");
  }
  if (!Number.isInteger(config.agents_block_budget_lines) || config.agents_block_budget_lines <= 0) {
    throw new MigrationError("v1 agents_block_budget_lines must be a positive integer");
  }
  if (typeof config.skills_path !== "string" || config.skills_path.trim() === "") {
    throw new MigrationError("v1 skills_path must be a non-empty string");
  }
}

function validateQueue(root) {
  const queueDir = path.join(root, ".kg", "queue");
  const items = [];
  const errors = [];
  if (!fs.existsSync(queueDir)) return { fingerprint: fingerprintPath(queueDir), items, errors };

  for (const entry of fs.readdirSync(queueDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(queueDir, entry.name);
    const rel = relativePortable(root, full);
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      errors.push({ path: rel, reason: "invalid_format", recommendation: "M3_quarantine" });
      continue;
    }
    let record;
    try {
      record = kyaml.parse(fs.readFileSync(full, "utf8"));
    } catch {
      errors.push({ path: rel, reason: "invalid_format", recommendation: "M3_quarantine" });
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.category !== "string") {
      errors.push({ path: rel, reason: "invalid_format", recommendation: "M3_quarantine" });
      continue;
    }
    if (!QUEUE_CATEGORIES.has(record.category)) {
      errors.push({ path: rel, reason: "unmappable_category", recommendation: "M3_quarantine" });
      continue;
    }
    items.push({ path: rel, category: record.category, strategy: "preserve_compatible_v1_record" });
  }
  return { fingerprint: fingerprintPath(queueDir), items, errors };
}

function operationPath(root, relative) {
  return host.resolveSafeRelative(root, relative, {
    mustExist: false,
    allowSymlink: true,
    forbidKg: false,
  }).full;
}

function writeOperation(root, relative, content, preserve, phase) {
  const full = operationPath(root, relative);
  return {
    path: relative,
    action: "write_file",
    phase,
    preserve,
    before: fingerprintPath(full),
    after: fingerprintBytes(content),
    content_base64: content.toString("base64"),
  };
}

function directoryOperation(root, relative) {
  const full = operationPath(root, relative);
  return {
    path: relative,
    action: "ensure_directory",
    phase: "layout",
    preserve: "lazy_directory_only_no_content_files",
    before: fingerprintPath(full),
    after: { type: "directory" },
  };
}

function skillOperation(root, name, sourceFingerprint) {
  const relative = `.agents/skills/${name}`;
  return {
    path: relative,
    action: "replace_skill",
    phase: "skills",
    preserve: "replace_managed_skill_with_v2_source",
    skill_name: name,
    before: fingerprintPath(operationPath(root, relative)),
    after: sourceFingerprint,
  };
}

function symlinkOperation(root, name, target) {
  const relative = `.claude/skills/${name}`;
  const content = Buffer.from(target);
  return {
    path: relative,
    action: "ensure_symlink",
    phase: "platform",
    preserve: "wire_to_canonical_agent_skill",
    before: fingerprintPath(operationPath(root, relative)),
    after: { type: "symlink", target, sha256: sha256(content) },
    target,
  };
}

function listLeafPaths(root) {
  const out = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  walk(root);
  return out;
}

function isWithin(relative, ancestor) {
  return relative === ancestor || relative.startsWith(`${ancestor}/`);
}

function currentKgSkillNames(root) {
  const skillsDir = path.join(root, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) throw new MigrationError("healthy v1 host is missing .agents/skills");
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("kg-"))
    .sort();
}

function validateInstalledSkillNames(root) {
  const names = currentKgSkillNames(root);
  const allowed = new Set([...V1_SKILL_NAMES, ...SKILL_NAMES]);
  const unknown = names.filter((name) => !allowed.has(name));
  if (unknown.length) {
    throw new MigrationError(`M2 cannot classify installed kg skill directories: ${unknown.join(", ")}`);
  }
  return names;
}

function assertHealthyV1Layout(root) {
  for (const relative of [
    ".kg/observations",
    ".kg/observations/processed",
    ".kg/queue",
    ".kg/reports",
    "knowledge",
    ".agents/skills",
  ]) {
    const current = fingerprintPath(path.join(root, relative));
    if (current.type !== "directory") {
      throw new MigrationError(`healthy v1 host is missing required directory: ${relative}`);
    }
  }
}

function sourceInventory(skillsSource, root) {
  const inventory = [];
  for (const name of SKILL_NAMES) {
    const source = path.join(skillsSource, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new MigrationError(`v2 skill source is missing ${name}: ${source}`);
    }
    const destination = path.join(root, ".agents", "skills", name);
    if (host.canonicalPath(source) === host.canonicalPath(destination)) {
      throw new MigrationError(
        `skill source and migration destination resolve to the same directory: ${name}\n` +
        `  If running from a host-installed location, specify --skills-source ` +
        `pointing to the kg plugin repository's skills/ directory.`,
      );
    }
    // KN-0003 self-contained invariant: every skill must carry vendored
    // scripts/lib/ and protocol/ so it can run from a lone directory.
    // sync-vendored.mjs enforces the same invariant at the repository
    // level; this check catches a checkout where sync wasn't run.
    const scriptsLib = path.join(source, "scripts", "lib");
    if (!fs.existsSync(scriptsLib) || !fs.statSync(scriptsLib).isDirectory()) {
      throw new MigrationError(
        `v2 skill source is incomplete: ${name} is missing scripts/lib/\n` +
        `  source: ${source}\n` +
        `  The migration source checkout may not have vendored dependencies synced.\n` +
        `  Run "node scripts/sync-vendored.mjs" in the kg plugin repository and retry.`,
      );
    }
    const protocolDir = path.join(source, "protocol");
    if (!fs.existsSync(protocolDir) || !fs.statSync(protocolDir).isDirectory()) {
      throw new MigrationError(
        `v2 skill source is incomplete: ${name} is missing protocol/\n` +
        `  source: ${source}\n` +
        `  The migration source checkout may not have vendored dependencies synced.\n` +
        `  Run "node scripts/sync-vendored.mjs" in the kg plugin repository and retry.`,
      );
    }
    inventory.push({
      name,
      path: relativePortable(skillsSource, source),
      fingerprint: fingerprintPath(source),
    });
  }
  return inventory;
}

function desiredClaudeTarget(root, name) {
  const parent = path.join(root, ".claude", "skills");
  const canonicalSkill = path.join(root, ".agents", "skills", name);
  return path.relative(host.canonicalPath(parent), host.canonicalPath(canonicalSkill));
}

function planCoreId(core) {
  return `MIG-${sha256(Buffer.from(stableJson(core))).slice(0, 16)}`;
}

function normalizeNow(nowValue) {
  const parsed = new Date(nowValue);
  if (Number.isNaN(parsed.getTime())) throw new MigrationError("--now must be an ISO timestamp");
  return parsed.toISOString();
}

export function buildMigrationPlan({ root: rootValue, skillsSource: sourceValue, now = new Date().toISOString() }) {
  const generatedAt = normalizeNow(now);
  const detection = detectMigration(rootValue);
  const root = detection.root.canonical;
  const configFile = path.join(root, ".kg", "config.yaml");
  const config = parseConfig(configFile);
  assertHealthyV1(detection, config);
  assertHealthyV1Layout(root);
  validateInstalledSkillNames(root);

  const agentsFile = path.join(root, "AGENTS.md");
  if (!fs.existsSync(agentsFile)) throw new MigrationError("healthy v1 host is missing AGENTS.md");
  const originalAgents = fs.readFileSync(agentsFile, "utf8");
  const migratedAgents = migrateAgentsText(originalAgents);

  const queue = validateQueue(root);
  if (queue.errors.length) throw new QueueMigrationError(queue.errors);

  const skillsDeclared = path.resolve(sourceValue);
  const skillsCanonical = host.canonicalPath(skillsDeclared);
  if (!fs.existsSync(skillsCanonical) || !fs.statSync(skillsCanonical).isDirectory()) {
    throw new MigrationError(`skills source is not a directory: ${skillsDeclared}`);
  }
  const skillSources = sourceInventory(skillsCanonical, root);

  const operations = [];
  const originalConfig = fs.readFileSync(configFile);
  const backupRelative = ".kg/config.v1.bak";
  const backupFile = path.join(root, backupRelative);
  const backupFingerprint = fingerprintPath(backupFile);
  if (backupFingerprint.type === "missing") {
    operations.push(writeOperation(root, backupRelative, originalConfig, "preserve_original_config_bytes", "backup"));
  } else if (!sameFingerprint(backupFingerprint, fingerprintBytes(originalConfig))) {
    throw new MigrationError(".kg/config.v1.bak exists but does not match the v1 config bytes");
  }

  const v2Config = {
    kind: "kg.config",
    version: 2,
    observation_threshold: config.observation_threshold,
    skills_path: config.skills_path,
  };
  const v2ConfigBytes = Buffer.from(
    "# kg pipeline configuration (KYAML).\n" + kyaml.stringify(v2Config),
  );
  operations.push(
    writeOperation(
      root,
      ".kg/config.yaml",
      v2ConfigBytes,
      "preserve_threshold_and_skills_path_remove_v1_budget",
      "state",
    ),
  );
  operations.push(
    writeOperation(
      root,
      "AGENTS.md",
      Buffer.from(migratedAgents.text),
      "preserve_manual_bytes_remove_v1_managed_block_add_v2_sections",
      "instructions",
    ),
  );

  for (const relative of V2_DIRECTORIES) {
    const current = fingerprintPath(operationPath(root, relative));
    if (current.type === "missing") operations.push(directoryOperation(root, relative));
    else if (current.type !== "directory") throw new MigrationError(`v2 directory path is occupied by a non-directory: ${relative}`);
  }

  for (const source of skillSources) {
    const destination = path.join(root, ".agents", "skills", source.name);
    if (!sameFingerprint(fingerprintPath(destination), source.fingerprint)) {
      operations.push(skillOperation(root, source.name, source.fingerprint));
    }
  }

  const claudeMarker = fs.existsSync(path.join(root, ".claude")) || fs.existsSync(path.join(root, "CLAUDE.md"));
  if (claudeMarker) {
    const claudeSkills = path.join(root, ".claude", "skills");
    const current = fingerprintPath(claudeSkills);
    if (current.type === "missing") operations.push(directoryOperation(root, ".claude/skills"));
    else if (current.type !== "directory") throw new MigrationError(".claude/skills is not a directory");

    for (const name of SKILL_NAMES) {
      const link = path.join(claudeSkills, name);
      const desired = desiredClaudeTarget(root, name);
      const currentLink = fingerprintPath(link);
      if (sameFingerprint(currentLink, { type: "symlink", target: desired, sha256: sha256(Buffer.from(desired)) })) {
        continue;
      }
      if (currentLink.type !== "missing") {
        if (currentLink.type !== "symlink") {
          throw new MigrationError(`.claude/skills/${name} exists and is not a symlink`);
        }
        if (host.canonicalPath(link) === host.canonicalPath(path.join(root, ".agents", "skills", name))) {
          continue;
        }
        throw new MigrationError(`.claude/skills/${name} does not resolve to the canonical skill`);
      }
      operations.push(symlinkOperation(root, name, desired));
    }

    const claudeFile = path.join(root, "CLAUDE.md");
    const claudeText = fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : null;
    if (claudeText === null) {
      operations.push(
        writeOperation(root, "CLAUDE.md", Buffer.from("@AGENTS.md\n"), "create_agents_import_for_claude_marker", "platform"),
      );
    } else if (!/^@AGENTS\.md[ \t]*$/m.test(claudeText)) {
      const separator = claudeText.endsWith("\n") ? "\n" : "\n\n";
      operations.push(
        writeOperation(
          root,
          "CLAUDE.md",
          Buffer.from(`${claudeText}${separator}@AGENTS.md\n`),
          "preserve_human_bytes_append_agents_import",
          "platform",
        ),
      );
    }
  }

  // Preserved set: everything in the host that is NOT touched by an
  // operation.  This is an implicit (subtractive) strategy — safe for M2
  // because only four write_file paths exist.  If M3 adds new operation
  // types or new target paths, add a preflight assertion that
  // operation paths ∩ preserved paths = ∅, so a newly-added operation
  // that overlaps a previously-preserved file is caught at plan-build
  // time rather than silently dropped from the preserved set.
  // Scaffolding left by an earlier, interrupted plan is migration-internal,
  // not host content: it is claimed here so it leaves the preserved set and
  // becomes a planned deletion instead of an execution-time improvisation.
  const orphans = scanMigrationScaffolding(root);
  const orphanPaths = orphans.map((orphan) => orphan.path);

  const operationPaths = operations.map((operation) => operation.path);
  const preserved = [];
  for (const full of listLeafPaths(root)) {
    const relative = relativePortable(root, full);
    if (operationPaths.some((candidate) => isWithin(relative, candidate))) continue;
    if (orphanPaths.some((candidate) => isWithin(relative, candidate))) continue;
    preserved.push({
      path: relative,
      fingerprint: fingerprintPath(full),
      strategy: "preserve_bytes_and_link_identity",
    });
  }

  const advisories = [];
  if (migratedAgents.line_count > 30) {
    advisories.push({
      code: "agents_line_budget_exceeded",
      line_count: migratedAgents.line_count,
      limit: 30,
      message: "AGENTS.md human content was preserved; review the file manually to reduce its line count.",
    });
  }

  const lazyAbsentFiles = LAZY_CONTENT_FILES.filter(
    (relative) => fingerprintPath(path.join(root, relative)).type === "missing",
  );
  const core = {
    kind: "kg.migration_plan",
    version: 1,
    generated_at: generatedAt,
    root: detection.root,
    skills_source: { declared: skillsDeclared, canonical: skillsCanonical },
    detection,
    skill_sources: skillSources,
    operations,
    preserved,
    queue: {
      fingerprint: queue.fingerprint,
      items: queue.items,
    },
    claude_marker: claudeMarker,
    agents: {
      injected_commands: migratedAgents.injected_commands,
      line_count: migratedAgents.line_count,
    },
    lazy_absent_files: lazyAbsentFiles,
    orphans,
    advisories,
  };
  return { ...core, id: planCoreId(core) };
}

function validatePlanId(plan) {
  const { id, ...core } = plan;
  if (id !== planCoreId(core)) throw new MigrationError("migration plan id does not match its content");
}

function validatePlanShape(plan) {
  assertPlainObject(plan, "migration plan");
  assertExactKeys(
    plan,
    [
      "kind",
      "version",
      "id",
      "generated_at",
      "root",
      "skills_source",
      "detection",
      "skill_sources",
      "operations",
      "preserved",
      "queue",
      "claude_marker",
      "agents",
      "lazy_absent_files",
      "orphans",
      "advisories",
    ],
    "migration plan",
  );
  if (plan.kind !== "kg.migration_plan" || plan.version !== 1) {
    throw new MigrationError("unsupported migration plan kind or version");
  }
  assertPlainObject(plan.root, "migration plan root");
  assertExactKeys(plan.root, ["declared", "canonical"], "migration plan root");
  assertPlainObject(plan.skills_source, "migration plan skills_source");
  assertExactKeys(plan.skills_source, ["declared", "canonical"], "migration plan skills_source");
  if (
    !Array.isArray(plan.operations) ||
    !Array.isArray(plan.preserved) ||
    !Array.isArray(plan.skill_sources) ||
    !Array.isArray(plan.orphans)
  ) {
    throw new MigrationError("migration plan operations, preserved, skill_sources, and orphans must be arrays");
  }
  validatePlanId(plan);
}

function decodeOperationContent(operation) {
  if (typeof operation.content_base64 !== "string") {
    throw new MigrationError(`write_file operation is missing content_base64: ${operation.path}`);
  }
  const content = Buffer.from(operation.content_base64, "base64");
  if (!sameFingerprint(fingerprintBytes(content), operation.after)) {
    throw new MigrationError(`write_file output fingerprint mismatch: ${operation.path}`);
  }
  return content;
}

function assertAllowedOperation(operation) {
  assertPlainObject(operation, "migration operation");
  const common = ["path", "action", "phase", "preserve", "before", "after"];
  const extraByAction = {
    write_file: ["content_base64"],
    ensure_directory: [],
    replace_skill: ["skill_name"],
    ensure_symlink: ["target"],
  };
  if (!Object.prototype.hasOwnProperty.call(extraByAction, operation.action)) {
    throw new MigrationError(`unsupported migration action: ${operation.action}`);
  }
  assertExactKeys(operation, [...common, ...extraByAction[operation.action]], `operation ${operation.path}`);

  if (operation.action === "write_file") {
    if (![".kg/config.v1.bak", ".kg/config.yaml", "AGENTS.md", "CLAUDE.md"].includes(operation.path)) {
      throw new MigrationError(`write_file path is outside the M2 allowlist: ${operation.path}`);
    }
    decodeOperationContent(operation);
  }
  if (operation.action === "ensure_directory" && ![...V2_DIRECTORIES, ".claude/skills"].includes(operation.path)) {
    throw new MigrationError(`ensure_directory path is outside the M2 allowlist: ${operation.path}`);
  }
  if (operation.action === "replace_skill") {
    if (!SKILL_NAMES.includes(operation.skill_name) || operation.path !== `.agents/skills/${operation.skill_name}`) {
      throw new MigrationError(`replace_skill path does not match its skill name: ${operation.path}`);
    }
  }
  if (operation.action === "ensure_symlink") {
    const name = path.posix.basename(operation.path);
    if (!SKILL_NAMES.includes(name) || operation.path !== `.claude/skills/${name}`) {
      throw new MigrationError(`ensure_symlink path is outside the M2 allowlist: ${operation.path}`);
    }
    if (operation.after?.type !== "symlink" || operation.after.target !== operation.target) {
      throw new MigrationError(`ensure_symlink output mismatch: ${operation.path}`);
    }
  }
}

function classifySimpleOperation(root, operation) {
  const full = operationPath(root, operation.path);
  const current = fingerprintPath(full);
  if (operation.action === "ensure_directory") {
    if (current.type === "missing") return "pending";
    if (current.type === "directory") return "applied";
    throw new MigrationError(`migration input drift at ${operation.path}`);
  }
  if (sameFingerprint(current, operation.after)) return "applied";
  if (sameFingerprint(current, operation.before)) return "pending";
  throw new MigrationError(`migration input drift at ${operation.path}`);
}

function stagePaths(root, plan, operation) {
  const parent = path.dirname(operationPath(root, operation.path));
  const suffix = `${plan.id}-${operation.skill_name}`;
  return {
    stage: path.join(parent, `.kg-migration-stage-${suffix}`),
    backup: path.join(parent, `.kg-migration-backup-${suffix}`),
  };
}

const STAGE_PREFIX = ".kg-migration-stage-";
const BACKUP_PREFIX = ".kg-migration-backup-";

// Scaffolding present while a plan is being built necessarily belongs to an
// earlier plan: this plan has not executed yet. Claiming it at build time is
// what lets the preserved set and the cleanup agree on who owns these paths.
function scanMigrationScaffolding(root) {
  const skillsDir = path.join(root, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const found = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.name.startsWith(STAGE_PREFIX) && !entry.name.startsWith(BACKUP_PREFIX)) continue;
    const full = path.join(skillsDir, entry.name);
    found.push({
      path: relativePortable(root, full),
      fingerprint: fingerprintPath(full),
      strategy: "remove_superseded_migration_scaffolding",
    });
  }
  return found;
}

function cleanupPlannedOrphans(root, orphans) {
  const cleaned = [];
  for (const orphan of orphans) {
    assertPlainObject(orphan, "orphan item");
    assertExactKeys(orphan, ["path", "fingerprint", "strategy"], `orphan item ${orphan.path}`);
    const full = operationPath(root, orphan.path);
    const current = fingerprintPath(full);
    if (current.type === "missing") continue;
    if (!sameFingerprint(current, orphan.fingerprint)) {
      throw new MigrationError(`migration scaffolding changed after plan generation: ${orphan.path}`);
    }
    fs.rmSync(full, { recursive: true, force: true });
    cleaned.push(orphan.path);
  }
  return cleaned;
}

function classifySkillOperation(root, plan, operation) {
  const full = operationPath(root, operation.path);
  const current = fingerprintPath(full);
  const internals = stagePaths(root, plan, operation);
  const backup = fingerprintPath(internals.backup);
  if (sameFingerprint(current, operation.after)) return "applied";
  if (sameFingerprint(current, operation.before)) {
    if (backup.type !== "missing") throw new MigrationError(`unexpected migration backup at ${operation.path}`);
    return "pending";
  }
  if (
    current.type === "missing" &&
    operation.before.type !== "missing" &&
    sameFingerprint(backup, operation.before)
  ) {
    return "resume";
  }
  throw new MigrationError(`migration input drift at ${operation.path}`);
}

function atomicWrite(full, content, planId) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const temporary = path.join(path.dirname(full), `.kg-migration-write-${planId}-${path.basename(full)}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, full);
}

function atomicSymlink(full, target, planId) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const temporary = path.join(path.dirname(full), `.kg-migration-link-${planId}-${path.basename(full)}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, full);
}

function prepareSkillStage(root, plan, operation, skillsSource) {
  const source = path.join(skillsSource, operation.skill_name);
  const internals = stagePaths(root, plan, operation);
  const stageFingerprint = fingerprintPath(internals.stage);
  if (!sameFingerprint(stageFingerprint, operation.after)) {
    fs.rmSync(internals.stage, { recursive: true, force: true });
    fs.cpSync(source, internals.stage, { recursive: true });
  }
  if (!sameFingerprint(fingerprintPath(internals.stage), operation.after)) {
    throw new MigrationError(`staged skill does not match plan output: ${operation.skill_name}`);
  }
}

function applySkillOperation(root, plan, operation) {
  const full = operationPath(root, operation.path);
  const internals = stagePaths(root, plan, operation);
  const state = classifySkillOperation(root, plan, operation);
  if (state === "applied") {
    fs.rmSync(internals.stage, { recursive: true, force: true });
    fs.rmSync(internals.backup, { recursive: true, force: true });
    return false;
  }
  if (state === "pending" && operation.before.type !== "missing") {
    fs.renameSync(full, internals.backup);
  }
  fs.renameSync(internals.stage, full);
  fs.rmSync(internals.backup, { recursive: true, force: true });
  return true;
}

function validateSourceInventory(plan, root) {
  const declaredCanonical = host.canonicalPath(plan.skills_source.declared);
  if (declaredCanonical !== plan.skills_source.canonical) {
    throw new MigrationError("skills source canonical identity changed after plan generation");
  }
  assertExactKeys(
    Object.fromEntries(plan.skill_sources.map((item) => [item.name, true])),
    SKILL_NAMES,
    "migration plan skill source names",
  );
  for (const source of plan.skill_sources) {
    const full = path.join(declaredCanonical, source.name);
    const destination = path.join(root, ".agents", "skills", source.name);
    if (host.canonicalPath(full) === host.canonicalPath(destination)) {
      throw new MigrationError(`skill source and migration destination resolve to the same directory: ${source.name}`);
    }
    if (!sameFingerprint(fingerprintPath(full), source.fingerprint)) {
      throw new MigrationError(`skill source changed after plan generation: ${source.name}`);
    }
  }
  return declaredCanonical;
}

function validatePreserved(root, preserved) {
  for (const item of preserved) {
    assertPlainObject(item, "preserved item");
    assertExactKeys(item, ["path", "fingerprint", "strategy"], `preserved item ${item.path}`);
    const current = fingerprintPath(operationPath(root, item.path));
    if (!sameFingerprint(current, item.fingerprint)) {
      throw new MigrationError(`preserved input changed after plan generation: ${item.path}`);
    }
  }
}

function validateConfigOutput(operation) {
  const content = decodeOperationContent(operation);
  let config;
  try {
    config = kyaml.parse(content.toString("utf8"));
  } catch (error) {
    throw new MigrationError(`planned v2 config is invalid: ${error.message}`);
  }
  assertPlainObject(config, "planned v2 config");
  assertExactKeys(config, V2_CONFIG_KEYS, "planned v2 config");
  if (config.kind !== "kg.config" || config.version !== 2) {
    throw new MigrationError("planned config is not kg.config version 2");
  }
  if (Object.prototype.hasOwnProperty.call(config, "agents_block_budget_lines")) {
    throw new MigrationError("planned v2 config retains agents_block_budget_lines");
  }
}

function validateMandatoryOperations(plan) {
  const byPath = new Map();
  for (const operation of plan.operations) {
    assertAllowedOperation(operation);
    if (byPath.has(operation.path)) throw new MigrationError(`duplicate migration operation: ${operation.path}`);
    byPath.set(operation.path, operation);
  }
  for (const required of [".kg/config.yaml", "AGENTS.md"]) {
    if (!byPath.has(required)) throw new MigrationError(`migration plan is missing required operation: ${required}`);
  }
  const config = byPath.get(".kg/config.yaml");
  validateConfigOutput(config);
  const agents = byPath.get("AGENTS.md");
  validateAgentsV2(decodeOperationContent(agents).toString("utf8"), {
    injectedCommands: plan.agents.injected_commands,
  });
  const backup = byPath.get(".kg/config.v1.bak");
  if (backup && !sameFingerprint(backup.after, config.before)) {
    throw new MigrationError("config backup bytes do not match the original config input");
  }
}

function phase2Validate(root, plan) {
  for (const operation of plan.operations) {
    const current = fingerprintPath(operationPath(root, operation.path));
    if (operation.action === "ensure_directory") {
      if (current.type !== "directory") throw new MigrationError(`Phase 2 missing directory: ${operation.path}`);
    } else if (!sameFingerprint(current, operation.after)) {
      throw new MigrationError(`Phase 2 output mismatch: ${operation.path}`);
    }
  }
  validatePreserved(root, plan.preserved);

  for (const orphan of plan.orphans) {
    if (fingerprintPath(operationPath(root, orphan.path)).type !== "missing") {
      throw new MigrationError(`Phase 2 migration scaffolding still present: ${orphan.path}`);
    }
  }
  if (scanMigrationScaffolding(root).length) {
    throw new MigrationError("Phase 2 found migration scaffolding that no plan claims");
  }

  const queue = validateQueue(root);
  if (queue.errors.length) throw new QueueMigrationError(queue.errors);
  if (!sameFingerprint(queue.fingerprint, plan.queue.fingerprint)) {
    throw new MigrationError("Phase 2 queue fingerprint changed");
  }

  const names = currentKgSkillNames(root);
  if (stableJson(names) !== stableJson([...SKILL_NAMES].sort())) {
    throw new MigrationError(`Phase 2 expected exactly seven kg skills; found ${names.join(", ")}`);
  }
  for (const source of plan.skill_sources) {
    const installed = path.join(root, ".agents", "skills", source.name);
    if (!sameFingerprint(fingerprintPath(installed), source.fingerprint)) {
      throw new MigrationError(`Phase 2 installed skill mismatch: ${source.name}`);
    }
  }

  if (plan.claude_marker) {
    const claudeSkills = path.join(root, ".claude", "skills");
    const claudeNames = fs
      .readdirSync(claudeSkills, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("kg-"))
      .sort();
    if (stableJson(claudeNames) !== stableJson([...SKILL_NAMES].sort())) {
      throw new MigrationError(`Phase 2 expected seven Claude skill links; found ${claudeNames.join(", ")}`);
    }
    for (const name of SKILL_NAMES) {
      const link = path.join(claudeSkills, name);
      if (!fs.lstatSync(link).isSymbolicLink()) throw new MigrationError(`Claude skill is not a symlink: ${name}`);
      if (host.canonicalPath(link) !== host.canonicalPath(path.join(root, ".agents", "skills", name))) {
        throw new MigrationError(`Claude skill link resolves incorrectly: ${name}`);
      }
    }
    if (!/^@AGENTS\.md[ \t]*$/m.test(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"))) {
      throw new MigrationError("Phase 2 CLAUDE.md does not import AGENTS.md");
    }
  }

  for (const relative of plan.lazy_absent_files) {
    if (fs.existsSync(path.join(root, relative))) {
      throw new MigrationError(`Phase 2 created a lazy content file: ${relative}`);
    }
  }
  validateAgentsV2(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), {
    injectedCommands: plan.agents.injected_commands,
  });
}

export function executeMigrationPlan({ root: rootValue, plan }) {
  validatePlanShape(plan);
  const executeRoot = host.assertSafeHostRoot(rootValue);
  if (executeRoot !== plan.root.canonical) {
    throw new MigrationError(
      `plan root and execute root have different canonical identities: ${plan.root.canonical} != ${executeRoot}`,
    );
  }
  if (host.canonicalPath(plan.root.declared) !== plan.root.canonical) {
    throw new MigrationError("plan root canonical identity changed after generation");
  }

  validateMandatoryOperations(plan);
  const skillsSource = validateSourceInventory(plan, executeRoot);
  validateInstalledSkillNames(executeRoot);
  validatePreserved(executeRoot, plan.preserved);
  const queue = validateQueue(executeRoot);
  if (queue.errors.length) throw new QueueMigrationError(queue.errors);
  if (!sameFingerprint(queue.fingerprint, plan.queue.fingerprint)) {
    throw new MigrationError("queue changed after plan generation");
  }

  const cleanedOrphans = cleanupPlannedOrphans(executeRoot, plan.orphans);

  const states = new Map();
  for (const operation of plan.operations) {
    const state =
      operation.action === "replace_skill"
        ? classifySkillOperation(executeRoot, plan, operation)
        : classifySimpleOperation(executeRoot, operation);
    states.set(operation.path, state);
  }

  const pendingSkills = plan.operations.filter(
    (operation) => operation.action === "replace_skill" && states.get(operation.path) !== "applied",
  );
  try {
    for (const operation of pendingSkills) prepareSkillStage(executeRoot, plan, operation, skillsSource);
  } catch (error) {
    for (const operation of pendingSkills) {
      const { stage } = stagePaths(executeRoot, plan, operation);
      fs.rmSync(stage, { recursive: true, force: true });
    }
    throw error;
  }

  const applied = [];
  const alreadyApplied = [];
  for (const operation of plan.operations) {
    let changed = false;
    if (operation.action === "ensure_directory") {
      if (states.get(operation.path) === "pending") {
        fs.mkdirSync(operationPath(executeRoot, operation.path), { recursive: true });
        changed = true;
      }
    } else if (operation.action === "write_file") {
      if (states.get(operation.path) === "pending") {
        atomicWrite(
          operationPath(executeRoot, operation.path),
          decodeOperationContent(operation),
          plan.id,
        );
        changed = true;
      }
    } else if (operation.action === "ensure_symlink") {
      if (states.get(operation.path) === "pending") {
        atomicSymlink(operationPath(executeRoot, operation.path), operation.target, plan.id);
        changed = true;
      }
    } else if (operation.action === "replace_skill") {
      changed = applySkillOperation(executeRoot, plan, operation);
    }
    (changed ? applied : alreadyApplied).push(operation.path);
  }

  phase2Validate(executeRoot, plan);
  return {
    kind: "kg.migration_result",
    version: 1,
    plan_id: plan.id,
    root: executeRoot,
    status: "complete",
    applied,
    already_applied: alreadyApplied,
    advisories: plan.advisories,
    cleaned_orphans: cleanedOrphans,
    recovery: {
      model: "reentrant_continue",
      command: "re-run --execute with the same plan after an interruption",
    },
  };
}

export function queueErrorReport(error) {
  return {
    kind: "kg.migration_error_report",
    version: 1,
    code: "unmappable_queue_items",
    items: error.items,
  };
}
