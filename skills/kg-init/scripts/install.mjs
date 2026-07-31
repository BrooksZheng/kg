// Install kg into a host repository after machine classification.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kyaml, host } from "./_lib.mjs";
import { detectMigration, ensureAgentsV2Text, MigrationError, SKILL_NAMES } from "./migration-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPTS_DIR, "..");
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, "..", "..", "..");
const DOCS_README_SOURCE = path.join(SKILL_ROOT, "assets", "project-docs", "docs", "README.md");
const PROFILE_DIRECTORIES = {
  none: [],
  lean: ["docs", "docs/architecture", "docs/decisions"],
  standard: [
    "docs",
    "docs/architecture",
    "docs/decisions",
    "docs/rfcs",
    "docs/api",
    "docs/standards",
    "docs/runbooks",
    "docs/traps",
    "docs/domain",
    "docs/proposals",
  ],
};
const MANAGED_EMPTY_DIRECTORIES = [
  ".kg",
  ".kg/observations",
  ".kg/observations/processed",
  ".kg/queue",
  ".kg/reports",
  ".kg/migration",
  "knowledge",
  "harness/artifacts",
  "harness/skills",
  "harness/scripts",
];
const log = (message) => console.log(`kg: ${message}`);

function fail(message) {
  throw new MigrationError(message);
}

function parseArgs(argv) {
  const parsed = {
    copy: false,
    threshold: host.CONFIG_DEFAULTS.observation_threshold,
    docsProfile: "none",
    projectStageHint: null,
    root: null,
  };
  const valueFlags = new Set(["--threshold", "--docs-profile", "--project-stage"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--copy") {
      parsed.copy = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
      if (arg === "--threshold") {
        const threshold = Number.parseInt(value, 10);
        if (!Number.isInteger(threshold) || threshold <= 0) fail("--threshold needs a positive integer");
        parsed.threshold = threshold;
      }
      if (arg === "--docs-profile") {
        if (!Object.hasOwn(PROFILE_DIRECTORIES, value)) fail("--docs-profile must be one of: none | lean | standard");
        parsed.docsProfile = value;
      }
      if (arg === "--project-stage") {
        if (!["greenfield", "brownfield"].includes(value)) {
          fail("--project-stage must be one of: greenfield | brownfield");
        }
        parsed.projectStageHint = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown option: ${arg}`);
    if (parsed.root !== null) fail("host root may be provided only once");
    parsed.root = arg;
  }
  parsed.root = path.resolve(parsed.root ?? process.env.KG_ROOT ?? process.cwd());
  return parsed;
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function ensureDirectory(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  if (exists(target)) {
    if (!fs.statSync(target).isDirectory()) fail(`${relative} exists and is not a directory`);
    return false;
  }
  fs.mkdirSync(target, { recursive: true });
  log(`created ${relative}/`);
  return true;
}

function preflightDirectories(root, relatives) {
  for (const relative of [...new Set(relatives)]) {
    const target = path.join(root, ...relative.split("/"));
    if (exists(target) && !fs.statSync(target).isDirectory()) {
      fail(`${relative} exists and is not a directory`);
    }
  }
}

function installResult(detection, status, nextAction) {
  return {
    kind: "kg.install_result",
    version: 2,
    root: detection.root,
    classification: detection.classification,
    status,
    next_action: nextAction,
    mutated: false,
    problems: detection.problems,
  };
}

function blockForClassification(detection) {
  if (detection.classification === "v1") {
    console.log(JSON.stringify(installResult(detection, "phase0_required", "generate_migration_plan"), null, 2));
    process.exitCode = 2;
    return true;
  }
  if (detection.classification === "partial_broken") {
    const nextAction = detection.requires_human ? "request_human" : "generate_repair_plan";
    console.log(JSON.stringify(installResult(detection, "repair_required", nextAction), null, 2));
    process.exitCode = 2;
    return true;
  }
  return false;
}

function preflightSkillSources() {
  for (const name of SKILL_NAMES) {
    const source = path.join(PLUGIN_ROOT, "skills", name);
    for (const required of ["SKILL.md", "scripts", "scripts/lib", "protocol"]) {
      const target = path.join(source, ...required.split("/"));
      const valid = required === "SKILL.md"
        ? exists(target) && fs.statSync(target).isFile()
        : exists(target) && fs.statSync(target).isDirectory();
      if (!valid) fail(`plugin skill ${name} is missing ${required}: ${target}`);
    }
  }
}

function copyDirectory(source, destination) {
  if (host.canonicalPath(source) === host.canonicalPath(destination)) {
    fail(`refusing to copy a directory onto itself: ${source}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function wireAgentSkills(root, copyMode) {
  const skillsDirectory = path.join(root, ".agents", "skills");
  fs.mkdirSync(skillsDirectory, { recursive: true });
  for (const name of SKILL_NAMES) {
    const source = path.join(PLUGIN_ROOT, "skills", name);
    const destination = path.join(skillsDirectory, name);
    if (copyMode) {
      copyDirectory(source, destination);
      for (const [sourceParts, destinationParts] of [
        [["scripts", "lib"], ["scripts", "lib"]],
        [["protocol"], ["protocol"]],
      ]) {
        const sharedSource = path.join(PLUGIN_ROOT, ...sourceParts);
        const embedded = path.join(destination, ...destinationParts);
        if (exists(sharedSource)) copyDirectory(sharedSource, embedded);
        else if (!exists(embedded)) fail(`cannot make ${name} self-contained: missing ${destinationParts.join("/")}`);
      }
      log(`copied skill ${name} -> .agents/skills/${name} (self-contained)`);
      continue;
    }
    const target = path.relative(host.canonicalPath(skillsDirectory), host.canonicalPath(source));
    fs.symlinkSync(target, destination);
    log(`symlinked .agents/skills/${name} -> ${target}`);
  }
}

function wireClaude(root) {
  const claudeDirectory = path.join(root, ".claude");
  const claudeFile = path.join(root, "CLAUDE.md");
  if (!exists(claudeDirectory) && !exists(claudeFile)) return;
  const agentsSkills = path.join(root, ".agents", "skills");
  const claudeSkills = path.join(claudeDirectory, "skills");
  fs.mkdirSync(claudeSkills, { recursive: true });
  for (const name of SKILL_NAMES) {
    const source = path.join(agentsSkills, name);
    const destination = path.join(claudeSkills, name);
    const target = path.relative(host.canonicalPath(claudeSkills), host.canonicalPath(source));
    fs.symlinkSync(target, destination);
    log(`symlinked .claude/skills/${name} -> ${target}`);
  }
  const existing = exists(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : "";
  if (!/^@AGENTS\.md[ \t]*$/m.test(existing)) {
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(claudeFile, `${existing}${separator}${existing === "" ? "" : "\n"}@AGENTS.md\n`);
    log(`${existing === "" ? "created" : "updated"} CLAUDE.md with @AGENTS.md import`);
  }
}

function desiredCursorignore(root) {
  const file = path.join(root, ".cursorignore");
  const existing = exists(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing.split(/\r?\n/).some((line) => line.trim() === ".kg/")) return null;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}# kg: keep uncompiled pipeline state out of normal work context\n.kg/\n`;
}

function installFreshHost(args, detection) {
  const root = detection.root.canonical;
  preflightSkillSources();
  const claudeMarked = exists(path.join(root, ".claude")) || exists(path.join(root, "CLAUDE.md"));
  preflightDirectories(root, [
    ...MANAGED_EMPTY_DIRECTORIES,
    ...PROFILE_DIRECTORIES[args.docsProfile],
    ".agents",
    ".agents/skills",
    ...(claudeMarked ? [".claude", ".claude/skills"] : []),
  ]);
  if (args.docsProfile !== "none" && (!exists(DOCS_README_SOURCE) || !fs.statSync(DOCS_README_SOURCE).isFile())) {
    fail(`project document README template missing: ${DOCS_README_SOURCE}`);
  }
  const readme = path.join(root, "docs", "README.md");
  if (args.docsProfile !== "none" && exists(readme) && !fs.statSync(readme).isFile()) {
    fail("docs/README.md exists and is not a file");
  }
  const claudeFile = path.join(root, "CLAUDE.md");
  if (exists(claudeFile) && !fs.statSync(claudeFile).isFile()) fail("CLAUDE.md exists and is not a file");
  const agentsFile = path.join(root, "AGENTS.md");
  const originalAgents = exists(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const agents = ensureAgentsV2Text(originalAgents);
  const cursorignore = desiredCursorignore(root);
  const detectedStage = detection.classification === "greenfield" ? "greenfield" : "brownfield";

  for (const relative of [...MANAGED_EMPTY_DIRECTORIES, ...PROFILE_DIRECTORIES[args.docsProfile]]) {
    ensureDirectory(root, relative);
  }

  const config = {
    kind: "kg.config",
    version: 2,
    observation_threshold: args.threshold,
    skills_path: ".agents/skills",
  };
  fs.writeFileSync(
    path.join(root, ".kg", "config.yaml"),
    `# kg pipeline configuration (KYAML).\n${kyaml.stringify(config)}`,
    { flag: "wx" },
  );
  log(`wrote .kg/config.yaml (version 2, threshold ${args.threshold})`);

  if (args.docsProfile !== "none") {
    if (!exists(readme)) {
      const content = fs
        .readFileSync(DOCS_README_SOURCE, "utf8")
        .replaceAll("{{PROJECT_NAME}}", path.basename(root))
        .replaceAll("{{PROJECT_STAGE}}", detectedStage)
        .replaceAll("{{CREATED_DATE}}", new Date().toISOString().slice(0, 10));
      fs.writeFileSync(readme, content, { flag: "wx" });
      log(`created docs/README.md (${args.docsProfile} directory profile)`);
    }
  }

  if (agents.text !== originalAgents) {
    fs.writeFileSync(agentsFile, agents.text);
    log(`${originalAgents === "" ? "created" : "updated"} AGENTS.md with v2 project entry sections`);
  }
  if (cursorignore !== null) {
    fs.writeFileSync(path.join(root, ".cursorignore"), cursorignore);
    log("added .kg/ to .cursorignore");
  }
  wireAgentSkills(root, args.copy);
  wireClaude(root);

  const verified = detectMigration(root);
  if (verified.classification !== "v2") {
    fail(`post-install verification failed with classification ${verified.classification}`);
  }
  if (args.projectStageHint !== null && args.projectStageHint !== detectedStage) {
    log(`ignored --project-stage ${args.projectStageHint}; detector classified the host as ${detectedStage}`);
  }
  log(`install complete at ${root}; classification v2 verified`);
  if (detection.bootstrap_recommended) log("bootstrap recommended: run kg-docs inventory and bootstrap in a separate session");
}

function verifyV2Host(detection) {
  const root = detection.root.canonical;
  let created = 0;
  preflightDirectories(root, MANAGED_EMPTY_DIRECTORIES);
  for (const relative of MANAGED_EMPTY_DIRECTORIES) created += ensureDirectory(root, relative) ? 1 : 0;
  const verified = detectMigration(root);
  if (verified.classification !== "v2") fail(`v2 verification failed with classification ${verified.classification}`);
  log(created === 0 ? "healthy v2 verified; no changes" : `healthy v2 verified; restored ${created} managed empty directories`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!exists(args.root) || !fs.statSync(args.root).isDirectory()) fail(`host root does not exist: ${args.root}`);
  const detection = detectMigration(args.root);
  if (blockForClassification(detection)) {
    // The machine result above is the complete outcome for this invocation.
  } else if (detection.classification === "v2") {
    verifyV2Host(detection);
  } else {
    installFreshHost(args, detection);
  }
} catch (error) {
  console.error(`kg: error: ${error.message}`);
  process.exitCode = 1;
}
