import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  "harness",
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

export class ManualMigrationError extends MigrationError {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.requiresHuman = true;
  }
}

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

function quarantineHasUnresolvedItems(root) {
  const quarantine = path.join(root, ".kg", "migration", "quarantine");
  if (!directory(quarantine)) return false;
  for (const entry of fs.readdirSync(quarantine, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    const manifestFile = path.join(quarantine, entry.name, "manifest.json");
    if (!regularFile(manifestFile)) return true;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (
        manifest.plan_id !== entry.name ||
        !Array.isArray(manifest.items) ||
        manifest.items.some((item) => item.resolution_status !== "resolved")
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function hasUnresolvedMigrationState(root, signals, problems) {
  const candidates = [
    [".kg/migration/active-plan.json", "active_migration_plan_present"],
    [".kg/migration/stage", "migration_stage_present"],
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
  if (quarantineHasUnresolvedItems(root)) {
    unresolved = true;
    detectionSignal(signals, "migration_quarantine_present", ".kg/migration/quarantine");
    detectionProblem(problems, "UNRESOLVED_MIGRATION_STATE", ".kg/migration/quarantine", "error", "human");
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

const PLAN_ID_TOKEN = "$PLAN_ID";
const MIGRATION_CHECKPOINTS = [
  "before_sealed_plan",
  "after_sealed_plan",
  "after_before_images",
  "during_quarantine_move",
  "after_quarantine_manifest",
  "during_skill_replace",
  "after_skill_replace",
  "after_config_write",
  "after_agents_write",
  "before_phase2_commit",
  "during_rollback_restore",
];

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function replacePlanReferences(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replacePlanReferences(item, from, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replacePlanReferences(item, from, to)]),
    );
  }
  return value;
}

export function computeMigrationPlanId(value) {
  const core = structuredClone(value);
  const existingId = typeof core.id === "string" ? core.id : null;
  delete core.id;
  delete core.generated_at;
  const normalized = existingId ? replacePlanReferences(core, existingId, PLAN_ID_TOKEN) : core;
  return `MIG-${sha256(Buffer.from(canonicalJson(normalized))).slice(0, 24)}`;
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
      throw new MigrationError(`queue entry is not a regular YAML file: ${rel}`);
    }
    const bytes = fs.readFileSync(full);
    let record;
    try {
      record = kyaml.parse(bytes.toString("utf8"));
    } catch {
      errors.push({
        path: rel,
        reason: "invalid_format",
        category: null,
        source_sha256: sha256(bytes),
        source_size: bytes.length,
      });
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.category !== "string") {
      errors.push({
        path: rel,
        reason: "invalid_format",
        category: null,
        source_sha256: sha256(bytes),
        source_size: bytes.length,
      });
      continue;
    }
    if (!QUEUE_CATEGORIES.has(record.category)) {
      errors.push({
        path: rel,
        reason: "unmappable_category",
        category: record.category,
        source_sha256: sha256(bytes),
        source_size: bytes.length,
      });
      continue;
    }
    items.push({
      path: rel,
      category: record.category,
      fingerprint: fingerprintBytes(bytes),
      strategy: "preserve_compatible_v1_record",
    });
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

function operationContract(root, relative, action, phase, preserve, before, after) {
  return {
    path: relative,
    action,
    phase,
    ownership: "migration_plan",
    preserve,
    before,
    after,
    recovery: { strategy: "compare_before_after_then_resume" },
    rollback: {
      strategy: before.type === "missing" ? "delete_if_plan_created" : "restore_verified_before_image",
    },
  };
}

function writeOperation(root, relative, content, preserve, phase) {
  const full = operationPath(root, relative);
  return {
    ...operationContract(
      root,
      relative,
      "write_file",
      phase,
      preserve,
      fingerprintPath(full),
      fingerprintBytes(content),
    ),
    content_base64: content.toString("base64"),
  };
}

function directoryOperation(root, relative) {
  const full = operationPath(root, relative);
  return operationContract(
    root,
    relative,
    "ensure_directory",
    "layout",
    "lazy_directory_only_no_content_files",
    fingerprintPath(full),
    { type: "directory" },
  );
}

function skillOperation(root, name, sourceFingerprint) {
  const relative = `.agents/skills/${name}`;
  return {
    ...operationContract(
      root,
      relative,
      "replace_skill",
      "skills",
      "replace_managed_skill_with_v2_source",
      fingerprintPath(operationPath(root, relative)),
      sourceFingerprint,
    ),
    skill_name: name,
  };
}

function symlinkOperation(root, name, target) {
  const relative = `.claude/skills/${name}`;
  const content = Buffer.from(target);
  return {
    ...operationContract(
      root,
      relative,
      "ensure_symlink",
      "platform",
      "wire_to_canonical_agent_skill",
      fingerprintPath(operationPath(root, relative)),
      { type: "symlink", target, sha256: sha256(content) },
    ),
    target,
  };
}

function removalOperation(root, item) {
  return operationContract(
    root,
    item.path,
    "remove_internal_scaffolding",
    "cleanup",
    item.strategy,
    item.fingerprint,
    { type: "missing" },
  );
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
    const required = [
      ["SKILL.md", "file"],
      ["scripts/_lib.mjs", "file"],
      [V2_SKILL_REQUIRED_CLI[name], "file"],
      ["scripts/lib", "directory"],
      ["protocol", "directory"],
    ];
    for (const [relative, type] of required) {
      const candidate = path.join(source, ...relative.split("/"));
      const current = fingerprintPath(candidate);
      if (current.type !== type) {
        throw new MigrationError(`v2 skill source is incomplete: ${name} is missing ${relative}`);
      }
      if (host.isOutside(host.canonicalPath(source), candidate)) {
        throw new MigrationError(`v2 skill source component escapes its skill root: ${name}/${relative}`);
      }
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

  const skillsDeclared = path.resolve(sourceValue);
  const skillsCanonical = host.canonicalPath(skillsDeclared);
  if (!fs.existsSync(skillsCanonical) || !fs.statSync(skillsCanonical).isDirectory()) {
    throw new MigrationError(`skills source is not a directory: ${skillsDeclared}`);
  }
  const skillSources = sourceInventory(skillsCanonical, root);
  const skillsSourceDigest = fingerprintDirectory(skillsCanonical).sha256;

  const orphanItems = scanMigrationScaffolding(root);
  const operations = orphanItems.map((item) => removalOperation(root, item));
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

  for (const relative of V2_DIRECTORIES.filter((item) => item !== ".kg/migration")) {
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

  const operationPaths = operations.map((operation) => operation.path);
  const quarantine = queue.errors.map((item, index) => ({
    source_path: item.path,
    quarantine_path: `.kg/migration/quarantine/${PLAN_ID_TOKEN}/items/${String(index + 1).padStart(4, "0")}-${path.posix.basename(item.path)}`,
    reason: item.reason,
    category: item.category,
    source_sha256: item.source_sha256,
    source_size: item.source_size,
    required_dispositions: ["convert", "retain_quarantined"],
  }));
  const quarantinePaths = quarantine.map((item) => item.source_path);
  const preserved = [];
  for (const full of listLeafPaths(root)) {
    const relative = relativePortable(root, full);
    if (operationPaths.some((candidate) => isWithin(relative, candidate))) continue;
    if (quarantinePaths.some((candidate) => isWithin(relative, candidate))) continue;
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
  const beforeImages = [];
  for (const operation of operations) {
    if (operation.before.type === "missing") continue;
    beforeImages.push({
      source_kind: "operation",
      target_path: operation.path,
      image_path: `.kg/migration/before-images/${PLAN_ID_TOKEN}/items/${String(beforeImages.length + 1).padStart(4, "0")}`,
      fingerprint: operation.before,
      ownership: "rollback_backup",
    });
  }
  for (const item of quarantine) {
    beforeImages.push({
      source_kind: "quarantine",
      target_path: item.source_path,
      image_path: `.kg/migration/before-images/${PLAN_ID_TOKEN}/items/${String(beforeImages.length + 1).padStart(4, "0")}`,
      fingerprint: { type: "file", size: item.source_size, sha256: item.source_sha256 },
      ownership: "rollback_backup",
    });
  }
  const imageByTarget = new Map(beforeImages.map((item) => [item.target_path, item.image_path]));
  const rollbackOperations = [
    ...[...operations].reverse().map((operation) => ({
      path: operation.path,
      action: operation.before.type === "missing" ? "delete_created" : "restore_before_image",
      ownership: "rollback",
      expected_current: operation.after,
      restored: operation.before,
      image_path: imageByTarget.get(operation.path) ?? null,
    })),
    ...[...quarantine].reverse().map((item) => ({
      path: item.source_path,
      action: "restore_quarantined",
      ownership: "rollback",
      expected_current: { type: "missing" },
      restored: { type: "file", size: item.source_size, sha256: item.source_sha256 },
      image_path: imageByTarget.get(item.source_path),
      quarantine_path: item.quarantine_path,
    })),
  ];
  const sourceLeaves = listLeafPaths(root).map((full) => ({
    path: relativePortable(root, full),
    fingerprint: fingerprintPath(full),
  }));
  const tokenCore = {
    kind: "kg.migration_plan",
    version: 2,
    generated_at: generatedAt,
    root: detection.root,
    source: {
      classification: detection.classification,
      signals: detection.signals,
      leaf_count: sourceLeaves.length,
      inventory_digest: sha256(Buffer.from(canonicalJson(sourceLeaves))),
    },
    skills_source: {
      declared: skillsDeclared,
      canonical: skillsCanonical,
      digest: skillsSourceDigest,
      entries: skillSources,
    },
    operations,
    preserved,
    quarantine,
    before_images: beforeImages,
    recovery: {
      checkpoints: MIGRATION_CHECKPOINTS.map((name, index) => ({ name, order: index + 1 })),
    },
    rollback: {
      operations: rollbackOperations,
    },
    lazy_absent_files: lazyAbsentFiles,
    advisories,
    context: {
      queue_fingerprint: queue.fingerprint,
      queue_items: queue.items,
      claude_marker: claudeMarker,
      agents_injected_commands: migratedAgents.injected_commands,
      agents_line_count: migratedAgents.line_count,
    },
  };
  const id = computeMigrationPlanId(tokenCore);
  const finalized = replacePlanReferences(tokenCore, PLAN_ID_TOKEN, id);
  const plan = {
    kind: finalized.kind,
    version: finalized.version,
    id,
    ...Object.fromEntries(Object.entries(finalized).filter(([key]) => !["kind", "version"].includes(key))),
  };
  assertOwnershipSets(plan, root, { requireInitialCompleteness: true });
  return plan;
}

function validatePlanId(plan) {
  if (!/^MIG-[0-9a-f]{24}$/.test(plan.id) || plan.id !== computeMigrationPlanId(plan)) {
    throw new MigrationError("migration plan id does not match its canonical content");
  }
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
      "source",
      "skills_source",
      "operations",
      "preserved",
      "quarantine",
      "before_images",
      "recovery",
      "rollback",
      "lazy_absent_files",
      "advisories",
      "context",
    ],
    "migration plan",
  );
  if (plan.kind !== "kg.migration_plan" || plan.version !== 2) {
    throw new MigrationError("unsupported migration plan kind or version");
  }
  assertPlainObject(plan.root, "migration plan root");
  assertExactKeys(plan.root, ["declared", "canonical"], "migration plan root");
  assertPlainObject(plan.source, "migration plan source");
  assertExactKeys(
    plan.source,
    ["classification", "signals", "leaf_count", "inventory_digest"],
    "migration plan source",
  );
  assertPlainObject(plan.skills_source, "migration plan skills_source");
  assertExactKeys(
    plan.skills_source,
    ["declared", "canonical", "digest", "entries"],
    "migration plan skills_source",
  );
  assertPlainObject(plan.recovery, "migration plan recovery");
  assertExactKeys(plan.recovery, ["checkpoints"], "migration plan recovery");
  assertPlainObject(plan.rollback, "migration plan rollback");
  assertExactKeys(plan.rollback, ["operations"], "migration plan rollback");
  assertPlainObject(plan.context, "migration plan context");
  assertExactKeys(
    plan.context,
    ["queue_fingerprint", "queue_items", "claude_marker", "agents_injected_commands", "agents_line_count"],
    "migration plan context",
  );
  if (
    !Array.isArray(plan.operations) ||
    !Array.isArray(plan.preserved) ||
    !Array.isArray(plan.quarantine) ||
    !Array.isArray(plan.before_images) ||
    !Array.isArray(plan.skills_source.entries) ||
    !Array.isArray(plan.recovery.checkpoints) ||
    !Array.isArray(plan.rollback.operations) ||
    !Array.isArray(plan.lazy_absent_files) ||
    !Array.isArray(plan.advisories)
  ) {
    throw new MigrationError("migration plan collection fields must be arrays");
  }
  const checkpointNames = plan.recovery.checkpoints.map((item) => item?.name);
  if (stableJson(checkpointNames) !== stableJson(MIGRATION_CHECKPOINTS)) {
    throw new MigrationError("migration plan recovery checkpoints are incomplete or out of order");
  }
  for (const [index, checkpoint] of plan.recovery.checkpoints.entries()) {
    assertPlainObject(checkpoint, "migration checkpoint");
    assertExactKeys(checkpoint, ["name", "order"], `migration checkpoint ${index + 1}`);
    if (checkpoint.order !== index + 1) throw new MigrationError("migration checkpoint order is invalid");
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
  const common = [
    "path",
    "action",
    "phase",
    "ownership",
    "preserve",
    "before",
    "after",
    "recovery",
    "rollback",
  ];
  const extraByAction = {
    write_file: ["content_base64"],
    ensure_directory: [],
    replace_skill: ["skill_name"],
    ensure_symlink: ["target"],
    remove_internal_scaffolding: [],
  };
  if (!Object.prototype.hasOwnProperty.call(extraByAction, operation.action)) {
    throw new MigrationError(`unsupported migration action: ${operation.action}`);
  }
  assertExactKeys(operation, [...common, ...extraByAction[operation.action]], `operation ${operation.path}`);

  if (operation.action === "write_file") {
    if (![".kg/config.v1.bak", ".kg/config.yaml", "AGENTS.md", "CLAUDE.md"].includes(operation.path)) {
      throw new MigrationError(`write_file path is outside the migration allowlist: ${operation.path}`);
    }
    decodeOperationContent(operation);
  }
  if (operation.action === "ensure_directory" && ![...V2_DIRECTORIES, ".claude/skills"].includes(operation.path)) {
    throw new MigrationError(`ensure_directory path is outside the migration allowlist: ${operation.path}`);
  }
  if (operation.action === "replace_skill") {
    if (!SKILL_NAMES.includes(operation.skill_name) || operation.path !== `.agents/skills/${operation.skill_name}`) {
      throw new MigrationError(`replace_skill path does not match its skill name: ${operation.path}`);
    }
  }
  if (operation.action === "ensure_symlink") {
    const name = path.posix.basename(operation.path);
    if (!SKILL_NAMES.includes(name) || operation.path !== `.claude/skills/${name}`) {
      throw new MigrationError(`ensure_symlink path is outside the migration allowlist: ${operation.path}`);
    }
    if (operation.after?.type !== "symlink" || operation.after.target !== operation.target) {
      throw new MigrationError(`ensure_symlink output mismatch: ${operation.path}`);
    }
  }
  if (operation.action === "remove_internal_scaffolding") {
    const name = path.posix.basename(operation.path);
    if (!name.startsWith(STAGE_PREFIX) && !name.startsWith(BACKUP_PREFIX)) {
      throw new MigrationError(`cleanup path is outside the migration scaffolding allowlist: ${operation.path}`);
    }
    if (operation.after?.type !== "missing") {
      throw new MigrationError(`cleanup output must be missing: ${operation.path}`);
    }
  }
  if (operation.ownership !== "migration_plan") {
    throw new MigrationError(`operation has invalid ownership: ${operation.path}`);
  }
  assertPlainObject(operation.recovery, `operation recovery ${operation.path}`);
  assertExactKeys(operation.recovery, ["strategy"], `operation recovery ${operation.path}`);
  assertPlainObject(operation.rollback, `operation rollback ${operation.path}`);
  assertExactKeys(operation.rollback, ["strategy"], `operation rollback ${operation.path}`);
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function assertNoCrossOverlap(leftName, left, rightName, right) {
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (pathsOverlap(leftPath, rightPath)) {
        throw new MigrationError(`${leftName} overlaps ${rightName}: ${leftPath} <> ${rightPath}`);
      }
    }
  }
}

function assertUniquePaths(items, key, label) {
  const paths = items.map((item) => item[key]);
  if (new Set(paths).size !== paths.length) throw new MigrationError(`${label} contains duplicate paths`);
  return paths;
}

function assertOwnershipSets(plan, root, { requireInitialCompleteness = false } = {}) {
  const operationTargets = assertUniquePaths(plan.operations, "path", "operation targets");
  const preservedRoots = assertUniquePaths(plan.preserved, "path", "preserved roots");
  const quarantineTargets = assertUniquePaths(plan.quarantine, "source_path", "quarantine targets");
  const quarantineDestinations = assertUniquePaths(plan.quarantine, "quarantine_path", "quarantine destinations");
  const rollbackBackups = assertUniquePaths(plan.before_images, "image_path", "rollback backups");

  assertNoCrossOverlap("operation targets", operationTargets, "preserved roots", preservedRoots);
  assertNoCrossOverlap("operation targets", operationTargets, "quarantine targets", quarantineTargets);
  assertNoCrossOverlap("preserved roots", preservedRoots, "quarantine targets", quarantineTargets);
  assertNoCrossOverlap("operation targets", operationTargets, "rollback backups", rollbackBackups);
  assertNoCrossOverlap("preserved roots", preservedRoots, "rollback backups", rollbackBackups);
  assertNoCrossOverlap("quarantine targets", quarantineTargets, "rollback backups", rollbackBackups);
  assertNoCrossOverlap("quarantine destinations", quarantineDestinations, "rollback backups", rollbackBackups);

  if (!requireInitialCompleteness) return;
  const canonicalSets = [operationTargets, preservedRoots, quarantineTargets, quarantineDestinations, rollbackBackups]
    .flat()
    .map((relative) => ({ relative, canonical: host.canonicalPath(operationPath(root, relative)) }));
  for (let left = 0; left < canonicalSets.length; left += 1) {
    for (let right = left + 1; right < canonicalSets.length; right += 1) {
      if (canonicalSets[left].relative !== canonicalSets[right].relative && canonicalSets[left].canonical === canonicalSets[right].canonical) {
        throw new MigrationError(
          `migration ownership paths share a canonical identity: ${canonicalSets[left].relative} <> ${canonicalSets[right].relative}`,
        );
      }
    }
  }

  const leaves = listLeafPaths(root).map((full) => relativePortable(root, full));
  for (const leaf of leaves) {
    const memberships = [
      operationTargets.some((candidate) => isWithin(leaf, candidate)),
      preservedRoots.some((candidate) => isWithin(leaf, candidate)),
      quarantineTargets.some((candidate) => isWithin(leaf, candidate)),
    ].filter(Boolean).length;
    if (memberships !== 1) {
      throw new MigrationError(`host leaf ownership is not complete and exclusive: ${leaf}`);
    }
  }
  const inventory = leaves.map((relative) => ({
    path: relative,
    fingerprint: fingerprintPath(operationPath(root, relative)),
  }));
  if (
    plan.source.leaf_count !== inventory.length ||
    plan.source.inventory_digest !== sha256(Buffer.from(canonicalJson(inventory)))
  ) {
    throw new MigrationError("migration source inventory changed after plan generation");
  }
}

function classifySimpleOperation(root, operation) {
  const full = operationPath(root, operation.path);
  const current = fingerprintPath(full);
  if (operation.action === "remove_internal_scaffolding") {
    if (current.type === "missing") return "applied";
    if (sameFingerprint(current, operation.before)) return "pending";
    return "drifted";
  }
  if (operation.action === "ensure_directory") {
    if (current.type === "missing") return "pending";
    if (current.type === "directory") return "applied";
    return "drifted";
  }
  if (sameFingerprint(current, operation.after)) return "applied";
  if (sameFingerprint(current, operation.before)) return "pending";
  return "drifted";
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
  return "drifted";
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

function applySkillOperation(root, plan, operation, onMidpoint = null) {
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
    if (onMidpoint) onMidpoint();
  } else if (state === "pending" && onMidpoint) {
    onMidpoint();
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
  if (fingerprintDirectory(declaredCanonical).sha256 !== plan.skills_source.digest) {
    throw new MigrationError("skills source digest changed after plan generation");
  }
  assertExactKeys(
    Object.fromEntries(plan.skills_source.entries.map((item) => [item.name, true])),
    SKILL_NAMES,
    "migration plan skill source names",
  );
  sourceInventory(declaredCanonical, root);
  for (const source of plan.skills_source.entries) {
    assertPlainObject(source, "migration skill source entry");
    assertExactKeys(source, ["name", "path", "fingerprint"], `migration skill source ${source.name}`);
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
      throw new ManualMigrationError("preserved_drift", `preserved input changed after plan generation: ${item.path}`);
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
    injectedCommands: plan.context.agents_injected_commands,
  });
  const backup = byPath.get(".kg/config.v1.bak");
  if (backup && !sameFingerprint(backup.after, config.before)) {
    throw new MigrationError("config backup bytes do not match the original config input");
  }

  for (const item of plan.preserved) {
    assertPlainObject(item, "preserved item");
    assertExactKeys(item, ["path", "fingerprint", "strategy"], `preserved item ${item.path}`);
  }
  for (const item of plan.quarantine) {
    assertPlainObject(item, "quarantine item");
    assertExactKeys(
      item,
      [
        "source_path",
        "quarantine_path",
        "reason",
        "category",
        "source_sha256",
        "source_size",
        "required_dispositions",
      ],
      `quarantine item ${item.source_path}`,
    );
    const expectedPrefix = `.kg/migration/quarantine/${plan.id}/items/`;
    if (!item.quarantine_path.startsWith(expectedPrefix)) {
      throw new MigrationError(`quarantine destination is outside its plan directory: ${item.quarantine_path}`);
    }
    if (stableJson(item.required_dispositions) !== stableJson(["convert", "retain_quarantined"])) {
      throw new MigrationError(`quarantine dispositions are invalid: ${item.source_path}`);
    }
    const source = operationPath(plan.root.canonical, item.source_path);
    const destination = operationPath(plan.root.canonical, item.quarantine_path);
    if (host.canonicalPath(source) === host.canonicalPath(destination)) {
      throw new MigrationError(`quarantine source and destination share an identity: ${item.source_path}`);
    }
  }
  for (const item of plan.before_images) {
    assertPlainObject(item, "before image");
    assertExactKeys(
      item,
      ["source_kind", "target_path", "image_path", "fingerprint", "ownership"],
      `before image ${item.target_path}`,
    );
    if (!item.image_path.startsWith(`.kg/migration/before-images/${plan.id}/items/`)) {
      throw new MigrationError(`before image path is outside its plan directory: ${item.image_path}`);
    }
    if (item.ownership !== "rollback_backup") throw new MigrationError("before image ownership is invalid");
  }
  if (plan.rollback.operations.length !== plan.operations.length + plan.quarantine.length) {
    throw new MigrationError("rollback operation set does not close over plan operations and quarantine");
  }
  for (const operation of plan.rollback.operations) {
    assertPlainObject(operation, "rollback operation");
    const expected = operation.action === "restore_quarantined"
      ? ["path", "action", "ownership", "expected_current", "restored", "image_path", "quarantine_path"]
      : ["path", "action", "ownership", "expected_current", "restored", "image_path"];
    assertExactKeys(operation, expected, `rollback operation ${operation.path}`);
    if (!['delete_created', 'restore_before_image', 'restore_quarantined'].includes(operation.action)) {
      throw new MigrationError(`unsupported rollback action: ${operation.action}`);
    }
  }
}

function migrationPaths(root, plan) {
  const migration = path.join(root, ".kg", "migration");
  return {
    migration,
    plans: path.join(migration, "plans"),
    plan: path.join(migration, "plans", `${plan.id}.json`),
    active: path.join(migration, "active-plan.json"),
    result: path.join(migration, "results", `${plan.id}.json`),
    beforeManifest: path.join(migration, "before-images", plan.id, "manifest.json"),
    quarantineManifest: path.join(migration, "quarantine", plan.id, "manifest.json"),
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomicIfChanged(file, value, planId) {
  const bytes = jsonBytes(value);
  if (regularFile(file) && fs.readFileSync(file).equals(bytes)) return false;
  atomicWrite(file, bytes, planId);
  return true;
}

function readJsonFile(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ManualMigrationError("corrupt_migration_state", `${label} is not usable JSON: ${error.message}`);
  }
  assertPlainObject(value, label);
  return value;
}

function checkpoint(root, name) {
  const raw = process.env.KG_MIGRATION_TEST_SEAM;
  if (!raw) return;
  let seam;
  try {
    seam = JSON.parse(raw);
  } catch (error) {
    throw new MigrationError(`KG_MIGRATION_TEST_SEAM is not valid JSON: ${error.message}`);
  }
  assertPlainObject(seam, "KG_MIGRATION_TEST_SEAM");
  assertExactKeys(seam, ["checkpoint", "ready", "release"], "KG_MIGRATION_TEST_SEAM");
  if (seam.checkpoint !== name) return;
  for (const [label, file] of [["ready", seam.ready], ["release", seam.release]]) {
    if (typeof file !== "string" || !host.isOutside(root, file)) {
      throw new MigrationError(`checkpoint ${label} path must be outside the host`);
    }
  }
  fs.mkdirSync(path.dirname(seam.ready), { recursive: true });
  fs.writeFileSync(seam.ready, `${name}\n`, { flag: "wx" });
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(seam.release)) Atomics.wait(signal, 0, 0, 25);
}

function activePointerValue(plan, phase, status = "active") {
  const paths = migrationPaths(plan.root.canonical, plan);
  const planBytes = jsonBytes(plan);
  return {
    kind: "kg.migration_active_plan",
    version: 2,
    plan_id: plan.id,
    plan_path: relativePortable(plan.root.canonical, paths.plan),
    plan_sha256: sha256(planBytes),
    status,
    phase,
  };
}

function validateActivePointer(pointer, plan) {
  assertPlainObject(pointer, "active migration pointer");
  assertExactKeys(
    pointer,
    ["kind", "version", "plan_id", "plan_path", "plan_sha256", "status", "phase"],
    "active migration pointer",
  );
  if (pointer.kind !== "kg.migration_active_plan" || pointer.version !== 2 || pointer.plan_id !== plan.id) {
    throw new ManualMigrationError("conflicting_active_plan", "active migration pointer does not match the plan");
  }
  const expected = migrationPaths(plan.root.canonical, plan);
  if (pointer.plan_path !== relativePortable(plan.root.canonical, expected.plan)) {
    throw new ManualMigrationError("conflicting_active_plan", "active migration pointer path is invalid");
  }
  if (pointer.plan_sha256 !== sha256(fs.readFileSync(expected.plan))) {
    throw new ManualMigrationError("corrupt_internal_plan", "sealed internal plan digest does not match the active pointer");
  }
}

function readActiveInternalPlan(root) {
  const active = path.join(root, ".kg", "migration", "active-plan.json");
  if (!fs.existsSync(active)) return null;
  const pointer = readJsonFile(active, "active migration pointer");
  if (typeof pointer.plan_id !== "string") {
    throw new ManualMigrationError("corrupt_active_pointer", "active migration pointer has no plan id");
  }
  const planFile = path.join(root, ".kg", "migration", "plans", `${pointer.plan_id}.json`);
  if (!regularFile(planFile)) {
    throw new ManualMigrationError("internal_plan_missing", "active pointer names a missing internal plan");
  }
  const plan = readJsonFile(planFile, "sealed internal migration plan");
  validatePlanShape(plan);
  if (plan.root.canonical !== root) {
    throw new ManualMigrationError("internal_plan_root_mismatch", "sealed internal plan belongs to another host");
  }
  validateActivePointer(pointer, plan);
  const planFiles = fs.readdirSync(path.dirname(planFile), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (planFiles.length !== 1 || planFiles[0].name !== `${plan.id}.json`) {
    throw new ManualMigrationError("multiple_active_plans", "multiple sealed plans exist during an active migration");
  }
  return { plan, pointer };
}

function readCompletedInternalPlan(root) {
  const plans = path.join(root, ".kg", "migration", "plans");
  if (!directory(plans)) return null;
  const files = fs.readdirSync(plans, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (files.length !== 1) return null;
  const plan = readJsonFile(path.join(plans, files[0].name), "sealed internal migration plan");
  validatePlanShape(plan);
  return plan;
}

export function recoverMigrationPlan({ root: rootValue, externalPlanPath = null, allowCompleted = false }) {
  const root = host.assertSafeHostRoot(rootValue);
  let external = null;
  let externalError = null;
  if (externalPlanPath) {
    try {
      external = readJsonFile(externalPlanPath, "external migration plan");
      validatePlanShape(external);
    } catch (error) {
      externalError = error;
    }
  }
  let active = null;
  let activeError = null;
  try {
    active = readActiveInternalPlan(root);
  } catch (error) {
    activeError = error;
  }
  if (activeError && external) {
    const activeFile = path.join(root, ".kg", "migration", "active-plan.json");
    const pointer = readJsonFile(activeFile, "active migration pointer");
    assertExactKeys(
      pointer,
      ["kind", "version", "plan_id", "plan_path", "plan_sha256", "status", "phase"],
      "active migration pointer",
    );
    const expectedPlan = migrationPaths(root, external).plan;
    const planFiles = directory(path.dirname(expectedPlan))
      ? fs.readdirSync(path.dirname(expectedPlan), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      : [];
    if (
      pointer.kind !== "kg.migration_active_plan" ||
      pointer.version !== 2 ||
      pointer.plan_id !== external.id ||
      pointer.plan_path !== relativePortable(root, expectedPlan) ||
      pointer.plan_sha256 !== sha256(jsonBytes(external)) ||
      planFiles.some((entry) => entry.name !== `${external.id}.json`)
    ) {
      throw new ManualMigrationError(activeError.code ?? "corrupt_internal_plan", activeError.message);
    }
    atomicWrite(expectedPlan, jsonBytes(external), external.id);
    active = readActiveInternalPlan(root);
  } else if (activeError) {
    throw new ManualMigrationError(activeError.code ?? "corrupt_internal_plan", activeError.message);
  }
  if (active) {
    if (external && external.id !== active.plan.id) {
      throw new ManualMigrationError("conflicting_active_plans", "external and internal plans do not match");
    }
    return { plan: active.plan, source: "sealed_internal" };
  }
  if (external) return { plan: external, source: "external" };
  if (allowCompleted) {
    const completed = readCompletedInternalPlan(root);
    if (completed) return { plan: completed, source: "sealed_internal_completed" };
  }
  if (externalError) {
    throw new ManualMigrationError("plans_unusable", `no usable migration plan remains: ${externalError.message}`);
  }
  throw new MigrationError("no migration plan is available; if the host is still v1, generate a new Phase 0 plan");
}

function sealInternalPlan(root, plan) {
  const paths = migrationPaths(root, plan);
  const existing = readActiveInternalPlan(root);
  if (existing) {
    if (existing.plan.id !== plan.id) {
      throw new ManualMigrationError("conflicting_active_plans", "another migration plan is already active");
    }
    return existing.pointer;
  }
  if (directory(paths.migration)) {
    const completed = readCompletedInternalPlan(root);
    if (completed && completed.id === plan.id && regularFile(paths.result)) return null;
    throw new ManualMigrationError("unknown_migration_scaffolding", "migration directory exists without a valid active plan");
  }

  const stageRoot = path.join(path.dirname(root), `.kg-migration-seal-${plan.id}-${path.basename(root)}`);
  if (!host.isOutside(root, stageRoot)) throw new MigrationError("seal staging path must be outside the host");
  if (fs.existsSync(stageRoot)) {
    throw new ManualMigrationError("seal_stage_conflict", `seal staging path already exists: ${stageRoot}`);
  }
  const stagedMigration = path.join(stageRoot, "migration");
  const stagedPlan = path.join(stagedMigration, "plans", `${plan.id}.json`);
  const pointer = activePointerValue(plan, "sealed");
  fs.mkdirSync(path.dirname(stagedPlan), { recursive: true });
  fs.writeFileSync(stagedPlan, jsonBytes(plan));
  fs.writeFileSync(path.join(stagedMigration, "active-plan.json"), jsonBytes(pointer));
  fs.renameSync(stagedMigration, paths.migration);
  fs.rmdirSync(stageRoot);
  const sealed = readActiveInternalPlan(root);
  if (!sealed || sealed.plan.id !== plan.id) throw new MigrationError("internal plan seal verification failed");
  return sealed.pointer;
}

function updateActive(root, plan, phase, status = "active") {
  const paths = migrationPaths(root, plan);
  if (!regularFile(paths.plan)) throw new ManualMigrationError("internal_plan_missing", "cannot update a missing internal plan");
  writeJsonAtomicIfChanged(paths.active, activePointerValue(plan, phase, status), plan.id);
}

function copyFingerprintValue(source, destination, fingerprint) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fingerprint.type === "file") fs.copyFileSync(source, destination);
  else if (fingerprint.type === "directory") fs.cpSync(source, destination, { recursive: true });
  else if (fingerprint.type === "symlink") fs.symlinkSync(fs.readlinkSync(source), destination);
  else throw new MigrationError(`unsupported before image type: ${fingerprint.type}`);
}

function ensureBeforeImages(root, plan) {
  const paths = migrationPaths(root, plan);
  for (const item of plan.before_images) {
    const target = operationPath(root, item.target_path);
    const image = operationPath(root, item.image_path);
    const imageFingerprint = fingerprintPath(image);
    if (imageFingerprint.type !== "missing") {
      if (!sameFingerprint(imageFingerprint, item.fingerprint)) {
        throw new ManualMigrationError("corrupt_before_image", `before image hash mismatch: ${item.target_path}`);
      }
      continue;
    }
    if (!sameFingerprint(fingerprintPath(target), item.fingerprint)) {
      throw new ManualMigrationError("missing_before_image", `before image is missing after its target changed: ${item.target_path}`);
    }
    copyFingerprintValue(target, image, item.fingerprint);
    if (!sameFingerprint(fingerprintPath(image), item.fingerprint)) {
      throw new MigrationError(`before image read-back failed: ${item.target_path}`);
    }
  }
  const manifest = {
    kind: "kg.migration_before_images",
    version: 2,
    plan_id: plan.id,
    status: "complete",
    items: plan.before_images,
  };
  writeJsonAtomicIfChanged(paths.beforeManifest, manifest, plan.id);
  const readBack = readJsonFile(paths.beforeManifest, "before image manifest");
  if (canonicalJson(readBack) !== canonicalJson(manifest)) throw new MigrationError("before image manifest read-back failed");
  for (const item of plan.before_images) {
    if (!sameFingerprint(fingerprintPath(operationPath(root, item.image_path)), item.fingerprint)) {
      throw new ManualMigrationError("corrupt_before_image", `before image changed after manifest write: ${item.target_path}`);
    }
  }
}

function quarantineManifestItem(item, previous = null) {
  return {
    source_path: item.source_path,
    quarantine_path: item.quarantine_path,
    source_sha256: item.source_sha256,
    reason: item.reason,
    category: item.category,
    required_dispositions: item.required_dispositions,
    resolution_status: previous?.resolution_status ?? "unresolved",
    disposition: previous?.disposition ?? null,
    output_sha256: previous?.output_sha256 ?? null,
  };
}

function readQuarantineManifest(root, plan, { required = false } = {}) {
  const file = migrationPaths(root, plan).quarantineManifest;
  if (!regularFile(file)) {
    if (required) throw new ManualMigrationError("quarantine_manifest_missing", "quarantine manifest is missing");
    return null;
  }
  const manifest = readJsonFile(file, "quarantine manifest");
  assertExactKeys(manifest, ["kind", "version", "plan_id", "status", "requires_human", "items"], "quarantine manifest");
  if (manifest.kind !== "kg.migration_quarantine" || manifest.version !== 2 || manifest.plan_id !== plan.id) {
    throw new ManualMigrationError("quarantine_manifest_mismatch", "quarantine manifest does not match the plan");
  }
  if (!Array.isArray(manifest.items) || manifest.items.length !== plan.quarantine.length) {
    throw new ManualMigrationError("quarantine_manifest_incomplete", "quarantine manifest item count is invalid");
  }
  const byPath = new Map(manifest.items.map((item) => [item.source_path, item]));
  if (byPath.size !== manifest.items.length) {
    throw new ManualMigrationError("quarantine_manifest_duplicate", "quarantine manifest contains duplicate paths");
  }
  for (const planned of plan.quarantine) {
    const item = byPath.get(planned.source_path);
    if (!item) throw new ManualMigrationError("quarantine_manifest_incomplete", "quarantine manifest omits a planned item");
    assertExactKeys(
      item,
      [
        "source_path",
        "quarantine_path",
        "source_sha256",
        "reason",
        "category",
        "required_dispositions",
        "resolution_status",
        "disposition",
        "output_sha256",
      ],
      `quarantine manifest item ${item.source_path}`,
    );
    for (const key of ["quarantine_path", "source_sha256", "reason", "category", "required_dispositions"]) {
      if (canonicalJson(item[key]) !== canonicalJson(planned[key])) {
        throw new ManualMigrationError("quarantine_manifest_mismatch", `quarantine manifest changed ${key}: ${item.source_path}`);
      }
    }
  }
  return manifest;
}

function moveQuarantineItems(root, plan) {
  if (plan.quarantine.length === 0) return null;
  const previous = readQuarantineManifest(root, plan);
  const previousByPath = new Map(previous?.items.map((item) => [item.source_path, item]) ?? []);
  let midpointReached = false;
  for (const item of plan.quarantine) {
    const source = operationPath(root, item.source_path);
    const destination = operationPath(root, item.quarantine_path);
    const sourceFingerprint = fingerprintPath(source);
    const destinationFingerprint = fingerprintPath(destination);
    const expected = { type: "file", size: item.source_size, sha256: item.source_sha256 };
    const prior = previousByPath.get(item.source_path);
    if (sameFingerprint(sourceFingerprint, expected) && destinationFingerprint.type === "missing") {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
      if (!midpointReached) {
        midpointReached = true;
        checkpoint(root, "during_quarantine_move");
      }
    } else if (sourceFingerprint.type === "missing" && sameFingerprint(destinationFingerprint, expected)) {
      continue;
    } else if (
      prior?.resolution_status === "resolved" &&
      prior.disposition === "convert" &&
      sourceFingerprint.sha256 === prior.output_sha256 &&
      sameFingerprint(destinationFingerprint, expected)
    ) {
      continue;
    } else if (sourceFingerprint.type !== "missing" && destinationFingerprint.type !== "missing") {
      throw new ManualMigrationError("quarantine_duplicate", `quarantine source and destination both exist: ${item.source_path}`);
    } else if (sourceFingerprint.type === "missing" && destinationFingerprint.type === "missing") {
      throw new ManualMigrationError("quarantine_item_missing", `quarantine source and destination are both missing: ${item.source_path}`);
    } else {
      throw new ManualMigrationError("quarantine_hash_mismatch", `quarantine item hash mismatch: ${item.source_path}`);
    }
  }
  const items = plan.quarantine.map((item) => quarantineManifestItem(item, previousByPath.get(item.source_path)));
  const unresolved = items.some((item) => item.resolution_status !== "resolved");
  const manifest = {
    kind: "kg.migration_quarantine",
    version: 2,
    plan_id: plan.id,
    status: unresolved ? "blocked_on_quarantine" : "resolved",
    requires_human: unresolved,
    items,
  };
  writeJsonAtomicIfChanged(migrationPaths(root, plan).quarantineManifest, manifest, plan.id);
  checkpoint(root, "after_quarantine_manifest");
  return manifest;
}

function validateQueueDraft(record) {
  assertPlainObject(record, "resolution convert record");
  assertExactKeys(
    record,
    ["kind", "category", "claim", "evidence", "options", "recommendation", "entry", "source_observations"],
    "resolution convert record",
  );
  if (!['conflict', 'promotion', 'proposal'].includes(record.kind)) throw new MigrationError("convert record kind is invalid");
  if (!QUEUE_CATEGORIES.has(record.category)) throw new MigrationError("convert record category is invalid");
  if (typeof record.claim !== "string" || record.claim.trim() === "") throw new MigrationError("convert record claim is required");
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) throw new MigrationError("convert record evidence is required");
  if (!Array.isArray(record.options) || record.options.length < 2) throw new MigrationError("convert record options are incomplete");
  if (typeof record.recommendation !== "string" || record.recommendation.trim() === "") {
    throw new MigrationError("convert record recommendation is required");
  }
  if (!(record.entry === null || typeof record.entry === "string")) throw new MigrationError("convert record entry is invalid");
  if (!Array.isArray(record.source_observations)) throw new MigrationError("convert record source_observations is invalid");
}

function canonicalQueueRecord(plan, sourcePath, draft) {
  validateQueueDraft(draft);
  return {
    id: path.posix.basename(sourcePath, ".yaml"),
    at: plan.generated_at.replace(/\.\d{3}Z$/, "Z"),
    kind: draft.kind,
    category: draft.category,
    claim: draft.claim,
    evidence: draft.evidence,
    options: draft.options,
    recommendation: draft.recommendation,
    entry: draft.entry,
    source_observations: draft.source_observations,
    resolution: "pending",
    resolution_note: null,
  };
}

export function resolveMigrationQuarantine({ root: rootValue, plan, resolution }) {
  validatePlanShape(plan);
  const root = host.assertSafeHostRoot(rootValue);
  if (root !== plan.root.canonical) throw new MigrationError("resolution root does not match the plan root");
  assertPlainObject(resolution, "migration resolution");
  assertExactKeys(resolution, ["kind", "version", "plan_id", "items"], "migration resolution");
  if (resolution.kind !== "kg.migration_resolution" || resolution.version !== 1 || resolution.plan_id !== plan.id) {
    throw new MigrationError("migration resolution plan id is invalid");
  }
  if (!Array.isArray(resolution.items) || resolution.items.length !== plan.quarantine.length) {
    throw new MigrationError("migration resolution must cover every quarantine item exactly once");
  }
  const resolutionByPath = new Map();
  for (const item of resolution.items) {
    assertPlainObject(item, "migration resolution item");
    const common = ["source_path", "source_sha256", "disposition"];
    const expected = item.disposition === "convert" ? [...common, "record"] : common;
    assertExactKeys(item, expected, `migration resolution item ${item.source_path ?? "unknown"}`);
    if (resolutionByPath.has(item.source_path)) throw new MigrationError("migration resolution contains duplicate paths");
    if (!['convert', 'retain_quarantined'].includes(item.disposition)) {
      throw new MigrationError(`unknown quarantine disposition: ${item.disposition}`);
    }
    if (item.disposition === "convert") validateQueueDraft(item.record);
    resolutionByPath.set(item.source_path, item);
  }

  const manifest = readQuarantineManifest(root, plan, { required: true });
  const manifestByPath = new Map(manifest.items.map((item) => [item.source_path, item]));
  const prepared = [];
  for (const planned of plan.quarantine) {
    const item = resolutionByPath.get(planned.source_path);
    if (!item || item.source_sha256 !== planned.source_sha256) {
      throw new MigrationError(`migration resolution hash or path mismatch: ${planned.source_path}`);
    }
    const audit = manifestByPath.get(planned.source_path);
    const quarantined = operationPath(root, planned.quarantine_path);
    if (fingerprintPath(quarantined).sha256 !== planned.source_sha256) {
      throw new ManualMigrationError("quarantine_hash_mismatch", `quarantine bytes changed: ${planned.source_path}`);
    }
    let outputSha = null;
    let output = null;
    let bytes = null;
    if (item.disposition === "convert") {
      output = operationPath(root, planned.source_path);
      bytes = Buffer.from(kyaml.stringify(canonicalQueueRecord(plan, planned.source_path, item.record)));
      outputSha = sha256(bytes);
      const current = fingerprintPath(output);
      if (current.type !== "missing" && (current.type !== "file" || current.sha256 !== outputSha)) {
        throw new ManualMigrationError("resolution_output_drift", `converted queue output drifted: ${planned.source_path}`);
      }
    } else if (fingerprintPath(operationPath(root, planned.source_path)).type !== "missing") {
      throw new ManualMigrationError("resolution_output_drift", `retain_quarantined source unexpectedly exists: ${planned.source_path}`);
    }
    if (audit.resolution_status === "resolved") {
      if (audit.disposition !== item.disposition || audit.output_sha256 !== outputSha) {
        throw new MigrationError(`migration resolution conflicts with an existing resolution: ${planned.source_path}`);
      }
    }
    prepared.push({ item, audit, output, bytes, outputSha });
  }

  let changed = false;
  for (const preparedItem of prepared) {
    if (preparedItem.output && fingerprintPath(preparedItem.output).type === "missing") {
      atomicWrite(preparedItem.output, preparedItem.bytes, plan.id);
      changed = true;
    }
    if (preparedItem.audit.resolution_status !== "resolved") {
      preparedItem.audit.resolution_status = "resolved";
      preparedItem.audit.disposition = preparedItem.item.disposition;
      preparedItem.audit.output_sha256 = preparedItem.outputSha;
      changed = true;
    }
  }
  manifest.status = "resolved";
  manifest.requires_human = false;
  if (changed) writeJsonAtomicIfChanged(migrationPaths(root, plan).quarantineManifest, manifest, plan.id);
  return executeMigrationPlan({ root, plan });
}

function validateScaffolding(root, plan) {
  const allowed = new Set(
    plan.operations
      .filter((operation) => operation.action === "replace_skill")
      .flatMap((operation) => Object.values(stagePaths(root, plan, operation)).map((item) => relativePortable(root, item))),
  );
  for (const operation of plan.operations.filter((item) => item.action === "remove_internal_scaffolding")) {
    allowed.add(operation.path);
  }
  for (const item of scanMigrationScaffolding(root)) {
    if (!allowed.has(item.path)) {
      throw new ManualMigrationError("unknown_migration_scaffolding", `unclaimed migration scaffolding exists: ${item.path}`);
    }
  }
}

function installedSkillSelfCheck(root, plan) {
  const names = currentKgSkillNames(root);
  if (stableJson(names) !== stableJson([...SKILL_NAMES].sort())) {
    throw new MigrationError(`Phase 2 expected exactly seven kg skills; found ${names.join(", ")}`);
  }
  for (const source of plan.skills_source.entries) {
    const installed = path.join(root, ".agents", "skills", source.name);
    if (!sameFingerprint(fingerprintPath(installed), source.fingerprint)) {
      throw new MigrationError(`Phase 2 installed skill mismatch: ${source.name}`);
    }
    for (const [relative, type] of [
      ["SKILL.md", "file"],
      ["scripts/_lib.mjs", "file"],
      [V2_SKILL_REQUIRED_CLI[source.name], "file"],
      ["scripts/lib", "directory"],
      ["protocol", "directory"],
    ]) {
      if (fingerprintPath(path.join(installed, ...relative.split("/"))).type !== type) {
        throw new MigrationError(`Phase 2 skill is not self-contained: ${source.name}/${relative}`);
      }
    }
    const syntax = spawnSync(process.execPath, ["--check", path.join(installed, V2_SKILL_REQUIRED_CLI[source.name])], {
      cwd: root,
      encoding: "utf8",
    });
    if (syntax.status !== 0) throw new MigrationError(`Phase 2 key CLI syntax failed: ${source.name}`);
    const resolverUrl = pathToFileURL(path.join(installed, "scripts", "_lib.mjs")).href;
    const resolver = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(resolverUrl)})`], {
      cwd: root,
      encoding: "utf8",
    });
    if (resolver.status !== 0) throw new MigrationError(`Phase 2 resolver load failed: ${source.name}`);
  }
}

function quarantineResolved(root, plan) {
  if (plan.quarantine.length === 0) return true;
  const manifest = readQuarantineManifest(root, plan, { required: true });
  return manifest.items.every((item) => item.resolution_status === "resolved");
}

function phase2Validate(root, plan) {
  const configOperation = plan.operations.find((operation) => operation.path === ".kg/config.yaml");
  const config = parseConfig(path.join(root, ".kg", "config.yaml"));
  if (!isValidV2Config(config)) throw new MigrationError("Phase 2 recomputed config is not valid v2");
  if (!sameFingerprint(fingerprintPath(path.join(root, ".kg", "config.yaml")), configOperation.after)) {
    throw new MigrationError("Phase 2 config bytes do not match the sealed plan");
  }
  const backupOperation = plan.operations.find((operation) => operation.path === ".kg/config.v1.bak");
  if (backupOperation && !sameFingerprint(fingerprintPath(path.join(root, ".kg", "config.v1.bak")), configOperation.before)) {
    throw new MigrationError("Phase 2 config backup does not match the original config bytes");
  }

  for (const operation of plan.operations) {
    const current = fingerprintPath(operationPath(root, operation.path));
    if (operation.action === "ensure_directory") {
      if (current.type !== "directory") throw new MigrationError(`Phase 2 missing directory: ${operation.path}`);
    } else if (!sameFingerprint(current, operation.after)) {
      throw new MigrationError(`Phase 2 output mismatch: ${operation.path}`);
    }
  }
  validatePreserved(root, plan.preserved);
  for (const item of plan.context.queue_items) {
    if (!sameFingerprint(fingerprintPath(operationPath(root, item.path)), item.fingerprint)) {
      throw new MigrationError(`Phase 2 compatible queue item changed: ${item.path}`);
    }
  }

  const quarantineManifest = plan.quarantine.length ? readQuarantineManifest(root, plan, { required: true }) : null;
  if (quarantineManifest) {
    const plannedDestinations = new Set(plan.quarantine.map((item) => item.quarantine_path));
    const itemDirectory = path.join(root, ".kg", "migration", "quarantine", plan.id, "items");
    const actual = directory(itemDirectory)
      ? listLeafPaths(itemDirectory).map((full) => relativePortable(root, full))
      : [];
    if (actual.some((relative) => !plannedDestinations.has(relative)) || actual.length !== plannedDestinations.size) {
      throw new MigrationError("Phase 2 quarantine items do not match the sealed plan");
    }
    for (const item of plan.quarantine) {
      if (fingerprintPath(operationPath(root, item.quarantine_path)).sha256 !== item.source_sha256) {
        throw new MigrationError(`Phase 2 quarantine bytes changed: ${item.source_path}`);
      }
    }
    if (quarantineManifest.items.some((item) => item.resolution_status !== "resolved")) {
      throw new MigrationError("Phase 2 cannot complete with unresolved quarantine items");
    }
  }

  installedSkillSelfCheck(root, plan);
  const agentsImage = plan.before_images.find((item) => item.target_path === "AGENTS.md");
  if (!agentsImage) throw new MigrationError("Phase 2 cannot locate the AGENTS.md before image");
  const originalAgents = fs.readFileSync(operationPath(root, agentsImage.image_path), "utf8");
  const recomputedAgents = migrateAgentsText(originalAgents);
  const actualAgents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  if (actualAgents !== recomputedAgents.text) throw new MigrationError("Phase 2 recomputed AGENTS.md does not match disk");
  validateAgentsV2(actualAgents, { injectedCommands: recomputedAgents.injected_commands });

  const claudeMarker = fs.existsSync(path.join(root, ".claude")) || fs.existsSync(path.join(root, "CLAUDE.md"));
  if (claudeMarker) {
    const claudeSkills = path.join(root, ".claude", "skills");
    const claudeNames = directory(claudeSkills)
      ? fs.readdirSync(claudeSkills, { withFileTypes: true }).filter((entry) => entry.name.startsWith("kg-")).map((entry) => entry.name).sort()
      : [];
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
    if (fs.existsSync(path.join(root, relative))) throw new MigrationError(`Phase 2 created a lazy content file: ${relative}`);
  }
  if (scanMigrationScaffolding(root).length) throw new MigrationError("Phase 2 found migration scaffolding");
  const beforeManifest = readJsonFile(migrationPaths(root, plan).beforeManifest, "before image manifest");
  if (beforeManifest.status !== "complete" || beforeManifest.plan_id !== plan.id) {
    throw new MigrationError("Phase 2 before image manifest is incomplete");
  }
  assertOwnershipSets(plan, root);
}

function operationState(root, plan, operation) {
  return operation.action === "replace_skill"
    ? classifySkillOperation(root, plan, operation)
    : classifySimpleOperation(root, operation);
}

function operationPhaseRank(operation) {
  return { cleanup: 1, skills: 2, backup: 3, state: 4, instructions: 5, platform: 6, layout: 7 }[operation.phase] ?? 99;
}

function resultValue(root, plan, applied, alreadyApplied, cleanedOrphans, initialStates) {
  return {
    kind: "kg.migration_result",
    version: 2,
    plan_id: plan.id,
    root,
    status: "complete",
    requires_human: false,
    applied,
    already_applied: alreadyApplied,
    actions: plan.operations.map((operation) => ({
      path: operation.path,
      initial_state: initialStates.get(operation.path) ?? "applied",
      state: "applied",
    })),
    advisories: plan.advisories,
    cleaned_orphans: cleanedOrphans,
    recovery: { model: "sealed_plan_reentrant_continue" },
  };
}

function terminalStateValue(plan) {
  return {
    kind: "kg.migration_state",
    version: 2,
    plan_id: plan.id,
    status: "complete",
    requires_human: false,
  };
}

function blockedResult(root, plan, initialStates) {
  return {
    kind: "kg.migration_result",
    version: 2,
    plan_id: plan.id,
    root,
    status: "blocked_on_quarantine",
    requires_human: true,
    unresolved: plan.quarantine.map((item) => item.source_path),
    actions: [
      ...plan.operations.map((operation) => ({
        path: operation.path,
        state: initialStates.get(operation.path) ?? "pending",
      })),
      ...plan.quarantine.map((item) => ({ path: item.source_path, state: "blocked" })),
    ],
  };
}

function validateExecutionRoot(rootValue, plan) {
  const root = host.assertSafeHostRoot(rootValue);
  if (root !== plan.root.canonical) {
    throw new MigrationError(`plan root and execute root have different canonical identities: ${plan.root.canonical} != ${root}`);
  }
  if (host.canonicalPath(plan.root.declared) !== plan.root.canonical) {
    throw new MigrationError("plan root canonical identity changed after generation");
  }
  return root;
}

function validateQueueStateBeforeMutation(root, plan, migrationStarted) {
  for (const item of plan.context.queue_items) {
    if (!sameFingerprint(fingerprintPath(operationPath(root, item.path)), item.fingerprint)) {
      throw new ManualMigrationError("queue_drift", `compatible queue item changed: ${item.path}`);
    }
  }
  for (const item of plan.quarantine) {
    const source = fingerprintPath(operationPath(root, item.source_path));
    const destination = fingerprintPath(operationPath(root, item.quarantine_path));
    const expected = { type: "file", size: item.source_size, sha256: item.source_sha256 };
    if (!migrationStarted && !sameFingerprint(source, expected)) {
      throw new MigrationError(`quarantine input changed after plan generation: ${item.source_path}`);
    }
    if (migrationStarted && !sameFingerprint(source, expected) && !sameFingerprint(destination, expected)) {
      throw new ManualMigrationError("quarantine_drift", `quarantine item is neither at source nor destination: ${item.source_path}`);
    }
  }
}

export function executeMigrationPlan({ root: rootValue, plan }) {
  validatePlanShape(plan);
  const root = validateExecutionRoot(rootValue, plan);
  validateMandatoryOperations(plan);
  const skillsSource = validateSourceInventory(plan, root);
  validateInstalledSkillNames(root);
  validatePreserved(root, plan.preserved);
  validateScaffolding(root, plan);
  const activeBefore = readActiveInternalPlan(root);
  if (activeBefore && activeBefore.plan.id !== plan.id) {
    throw new ManualMigrationError("conflicting_active_plans", "execute plan conflicts with the active internal plan");
  }
  assertOwnershipSets(plan, root, { requireInitialCompleteness: !activeBefore && !directory(path.join(root, ".kg", "migration")) });
  validateQueueStateBeforeMutation(
    root,
    plan,
    Boolean(activeBefore) || directory(path.join(root, ".kg", "migration")),
  );

  const initialStates = new Map();
  for (const operation of plan.operations) {
    const state = operationState(root, plan, operation);
    if (state === "drifted") throw new ManualMigrationError("target_drifted", `migration target drifted: ${operation.path}`);
    initialStates.set(operation.path, state);
  }

  const paths = migrationPaths(root, plan);
  if (!activeBefore && regularFile(paths.result) && !fs.existsSync(paths.active)) {
    const allApplied = [...initialStates.values()].every((state) => state === "applied");
    if (allApplied && quarantineResolved(root, plan)) {
      phase2Validate(root, plan);
      return resultValue(root, plan, [], plan.operations.map((item) => item.path), [], initialStates);
    }
    updateActive(root, plan, "resume");
  }

  checkpoint(root, "before_sealed_plan");
  if (!regularFile(paths.plan)) sealInternalPlan(root, plan);
  else if (!regularFile(paths.active)) updateActive(root, plan, "resume");
  checkpoint(root, "after_sealed_plan");

  ensureBeforeImages(root, plan);
  updateActive(root, plan, "before_images_complete");
  checkpoint(root, "after_before_images");

  const quarantine = moveQuarantineItems(root, plan);
  if (quarantine?.items.some((item) => item.resolution_status !== "resolved")) {
    updateActive(root, plan, "quarantine", "blocked_on_quarantine");
    return blockedResult(root, plan, initialStates);
  }
  updateActive(root, plan, "applying");

  const states = new Map();
  for (const operation of plan.operations) {
    const state = operationState(root, plan, operation);
    if (state === "drifted") throw new ManualMigrationError("target_drifted", `migration target drifted: ${operation.path}`);
    states.set(operation.path, state);
  }
  const pendingSkills = plan.operations.filter(
    (operation) => operation.action === "replace_skill" && states.get(operation.path) !== "applied",
  );
  try {
    for (const operation of pendingSkills) prepareSkillStage(root, plan, operation, skillsSource);
  } catch (error) {
    for (const operation of pendingSkills) fs.rmSync(stagePaths(root, plan, operation).stage, { recursive: true, force: true });
    throw error;
  }

  const applied = [];
  const alreadyApplied = [];
  const cleanedOrphans = [];
  let skillMidpoint = false;
  const ordered = [...plan.operations].sort((left, right) => {
    const rank = operationPhaseRank(left) - operationPhaseRank(right);
    return rank || plan.operations.indexOf(left) - plan.operations.indexOf(right);
  });
  for (const operation of ordered) {
    const state = states.get(operation.path);
    let changed = false;
    if (operation.action === "remove_internal_scaffolding") {
      if (state === "pending") {
        fs.rmSync(operationPath(root, operation.path), { recursive: true, force: true });
        cleanedOrphans.push(operation.path);
        changed = true;
      }
    } else if (operation.action === "ensure_directory") {
      if (state === "pending") {
        fs.mkdirSync(operationPath(root, operation.path), { recursive: true });
        changed = true;
      }
    } else if (operation.action === "write_file") {
      if (state === "pending") {
        atomicWrite(operationPath(root, operation.path), decodeOperationContent(operation), plan.id);
        changed = true;
      }
    } else if (operation.action === "ensure_symlink") {
      if (state === "pending") {
        atomicSymlink(operationPath(root, operation.path), operation.target, plan.id);
        changed = true;
      }
    } else if (operation.action === "replace_skill") {
      changed = applySkillOperation(root, plan, operation, !skillMidpoint ? () => {
        skillMidpoint = true;
        checkpoint(root, "during_skill_replace");
      } : null);
    }
    if (operation.action === "replace_skill" && operation === ordered.filter((item) => item.action === "replace_skill").at(-1)) {
      checkpoint(root, "after_skill_replace");
    }
    if (operation.path === ".kg/config.yaml") checkpoint(root, "after_config_write");
    if (operation.path === "AGENTS.md") checkpoint(root, "after_agents_write");
    (changed ? applied : alreadyApplied).push(operation.path);
  }

  updateActive(root, plan, "phase2");
  phase2Validate(root, plan);
  updateActive(root, plan, "phase2_validated");
  checkpoint(root, "before_phase2_commit");
  const result = resultValue(root, plan, applied, alreadyApplied, cleanedOrphans, initialStates);
  writeJsonAtomicIfChanged(paths.result, terminalStateValue(plan), plan.id);
  fs.rmSync(paths.active, { force: true });
  return result;
}

function rollbackStagePath(root, plan, index) {
  return path.join(root, ".kg", "migration", "rollback", plan.id, `${String(index + 1).padStart(4, "0")}`);
}

function rollbackCurrentAllowed(root, operation) {
  const current = fingerprintPath(operationPath(root, operation.path));
  if (operation.action === "delete_created") {
    if (current.type === "missing") return "done";
    if (operation.expected_current.type === "directory" && current.type === "directory") return "delete";
    if (sameFingerprint(current, operation.expected_current)) return "delete";
    return "drifted";
  }
  if (sameFingerprint(current, operation.restored)) return "done";
  if (sameFingerprint(current, operation.expected_current)) return "restore";
  if (current.type === "missing") return "resume";
  return "drifted";
}

function preflightRollback(root, plan) {
  for (const [index, operation] of plan.rollback.operations.entries()) {
    if (operation.action === "restore_quarantined") {
      const source = fingerprintPath(operationPath(root, operation.path));
      const destination = fingerprintPath(operationPath(root, operation.quarantine_path));
      if (sameFingerprint(source, operation.restored) && destination.type === "missing") continue;
      if (destination.sha256 !== operation.restored.sha256) {
        throw new ManualMigrationError("rollback_quarantine_drift", `rollback quarantine bytes are unavailable: ${operation.path}`);
      }
      if (source.type !== "missing") {
        const manifest = readQuarantineManifest(root, plan, { required: true });
        const item = manifest.items.find((candidate) => candidate.source_path === operation.path);
        if (item?.disposition !== "convert" || source.sha256 !== item.output_sha256) {
          throw new ManualMigrationError("rollback_target_drift", `rollback queue target drifted: ${operation.path}`);
        }
      }
      continue;
    }
    const state = rollbackCurrentAllowed(root, operation);
    if (state === "drifted") throw new ManualMigrationError("rollback_target_drift", `rollback target drifted: ${operation.path}`);
    if (
      state === "delete" &&
      operation.expected_current.type === "directory" &&
      operation.expected_current.sha256 === undefined
    ) {
      const target = operationPath(root, operation.path);
      const ownedDescendants = plan.rollback.operations
        .filter((candidate) => candidate !== operation && candidate.action === "delete_created")
        .map((candidate) => candidate.path);
      const unowned = [];
      function walk(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          const relative = relativePortable(root, full);
          if (!ownedDescendants.some((candidate) => isWithin(relative, candidate))) unowned.push(relative);
          else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
        }
      }
      walk(target);
      if (unowned.length) {
        throw new ManualMigrationError(
          "rollback_created_directory_not_empty",
          `rollback refuses to delete unowned content under a created directory: ${unowned[0]}`,
        );
      }
    }
    if (state === "restore" || state === "resume") {
      const image = operation.image_path ? fingerprintPath(operationPath(root, operation.image_path)) : { type: "missing" };
      const stage = fingerprintPath(rollbackStagePath(root, plan, index));
      if (!sameFingerprint(image, operation.restored) && !sameFingerprint(stage, operation.restored)) {
        throw new ManualMigrationError("corrupt_before_image", `rollback before image is missing or corrupt: ${operation.path}`);
      }
    }
  }
}

export function rollbackMigrationPlan({ root: rootValue, plan }) {
  validatePlanShape(plan);
  const root = validateExecutionRoot(rootValue, plan);
  validateMandatoryOperations(plan);
  preflightRollback(root, plan);
  const migrationExists = directory(path.join(root, ".kg", "migration"));
  if (migrationExists && regularFile(migrationPaths(root, plan).plan)) updateActive(root, plan, "rollback");
  let midpoint = false;
  const restored = [];
  const deleted = [];
  for (const [index, operation] of plan.rollback.operations.entries()) {
    if (operation.action === "restore_quarantined") {
      const source = operationPath(root, operation.path);
      const destination = operationPath(root, operation.quarantine_path);
      if (sameFingerprint(fingerprintPath(source), operation.restored) && fingerprintPath(destination).type === "missing") continue;
      if (fingerprintPath(source).type !== "missing") fs.rmSync(source, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.renameSync(destination, source);
      restored.push(operation.path);
      continue;
    }
    const state = rollbackCurrentAllowed(root, operation);
    if (state === "done") continue;
    const target = operationPath(root, operation.path);
    if (operation.action === "delete_created") {
      if (
        fingerprintPath(target).type === "directory" &&
        operation.expected_current.sha256 === undefined &&
        fs.readdirSync(target).length !== 0
      ) {
        throw new ManualMigrationError(
          "rollback_created_directory_not_empty",
          `rollback refuses to delete a nonempty created directory: ${operation.path}`,
        );
      }
      fs.rmSync(target, { recursive: true, force: true });
      deleted.push(operation.path);
      continue;
    }
    const stage = rollbackStagePath(root, plan, index);
    if (!sameFingerprint(fingerprintPath(stage), operation.restored)) {
      fs.rmSync(stage, { recursive: true, force: true });
      copyFingerprintValue(operationPath(root, operation.image_path), stage, operation.restored);
    }
    if (fingerprintPath(target).type !== "missing") fs.rmSync(target, { recursive: true, force: true });
    if (!midpoint) {
      midpoint = true;
      checkpoint(root, "during_rollback_restore");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(stage, target);
    restored.push(operation.path);
  }
  for (const operation of plan.operations.filter((item) => item.action === "replace_skill")) {
    const internals = stagePaths(root, plan, operation);
    fs.rmSync(internals.stage, { recursive: true, force: true });
    fs.rmSync(internals.backup, { recursive: true, force: true });
  }
  const migration = path.join(root, ".kg", "migration");
  if (directory(migration)) fs.rmSync(migration, { recursive: true, force: true });
  const detection = detectMigration(root);
  if (detection.classification !== "v1" || detection.condition !== "healthy") {
    throw new ManualMigrationError("rollback_verification_failed", "rollback did not converge to a healthy v1 host");
  }
  return {
    kind: "kg.migration_rollback_result",
    version: 2,
    plan_id: plan.id,
    root,
    status: "clean_v1",
    requires_human: false,
    restored,
    deleted,
  };
}

export function migrationErrorReport(error) {
  const report = {
    kind: "kg.migration_error_report",
    version: 2,
    code: error.code ?? "migration_failed",
    status: error.requiresHuman ? "manual_recovery_required" : "failed",
    requires_human: error.requiresHuman === true,
    message: error.message,
  };
  if (["target_drifted", "rollback_target_drift", "resolution_output_drift"].includes(report.code)) {
    report.action_state = "drifted";
  }
  return report;
}

export function queueErrorReport(error) {
  return migrationErrorReport(error);
}
