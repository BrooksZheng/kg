// Black-box deterministic runner for the seven M2 walking-skeleton parts.
// R2.2 implements Part 1 through Part 3. Later registered parts report pending.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = "2026-07-31T00:00:00Z";
const MIGRATION_NOW = "2026-07-31T00:00:00.000Z";
const PARTS = [
  { number: 1, name: "migration_v1_minimal_preserves_assets", status: "implemented", run: runPart1 },
  { number: 2, name: "docs_bootstrap_renders_architecture_draft", status: "implemented", run: runPart2 },
  { number: 3, name: "observe_json_preserves_v1_contract", status: "implemented", run: runPart3 },
  { number: 4, name: "compile_links_observation_kn_and_managed_block", status: "pending" },
  { number: 5, name: "kickoff_indexes_compiled_kn_and_carrier", status: "pending" },
  { number: 6, name: "spec_archives_compiled_context_transcript", status: "pending" },
  { number: 7, name: "scan_reports_one_missing_source_ref", status: "pending" },
];

const DOCS_INVENTORY = path.join(ROOT, "skills", "kg-docs", "scripts", "inventory.mjs");
const DOCS_BOOTSTRAP = path.join(ROOT, "skills", "kg-docs", "scripts", "bootstrap.mjs");
const OBSERVE_ADD = path.join(ROOT, "skills", "kg-observe", "scripts", "add-observation.mjs");
const OBSERVE_VALIDATE = path.join(ROOT, "skills", "kg-observe", "scripts", "validate-observations.mjs");
const OBSERVE_THRESHOLD = path.join(ROOT, "skills", "kg-observe", "scripts", "check-threshold.mjs");
const OBSERVE_ARCHIVE = path.join(ROOT, "skills", "kg-compile", "scripts", "archive-observations.mjs");
const DOCS_VALIDATE = path.join(ROOT, "skills", "kg-compile", "scripts", "validate-project-documents.mjs");
const MIGRATION_DETECT = path.join(ROOT, "skills", "kg-init", "scripts", "detect-migration.mjs");
const MIGRATION_EXECUTE = path.join(ROOT, "skills", "kg-init", "scripts", "migrate-v1.mjs");
const PROTOCOL_SELF_CHECK = path.join(ROOT, "scripts", "lib", "protocol.mjs");
const SYNC_VENDORED = path.join(ROOT, "scripts", "sync-vendored.mjs");
const EVAL_BOOTSTRAP = path.join(ROOT, "scripts", "eval-bootstrap.mjs");
const MOCK_BOOTSTRAP_RUNNER = path.join(ROOT, "scripts", "fixtures", "m2", "mock-bootstrap-runner.mjs");
const BOOTSTRAP_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "bootstrap");
const OBSERVE_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "observe");
const MIGRATION_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "migration-v1");
const KG_SKILLS = ["kg-init", "kg-observe", "kg-compile", "kg-scan", "kg-kickoff", "kg-spec", "kg-docs"];

class CaseFailure extends Error {
  constructor(context, message, details = {}) {
    super(message);
    this.context = { ...context };
    this.command = details.command ?? context.command ?? "filesystem assertion";
    this.exitCode = details.exitCode ?? "n/a";
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

function commandText(script, args) {
  return [process.execPath, script, ...args].map((value) => JSON.stringify(String(value))).join(" ");
}

function runNode(context, script, args = [], options = {}) {
  const command = commandText(script, args);
  context.command = command;
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? context.root,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const exitCode = result.status ?? (result.error ? "spawn_error" : "unknown");
  const expectedFailure = options.expectFailure === true;
  const unexpected = expectedFailure ? result.status === 0 : result.status !== 0 || result.error;
  if (unexpected) {
    throw new CaseFailure(
      context,
      expectedFailure ? "command unexpectedly succeeded" : `command failed: ${result.error?.message ?? "nonzero exit"}`,
      {
        command,
        exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      },
    );
  }
  return result;
}

function ensure(context, condition, message) {
  if (!condition) throw new CaseFailure(context, message);
}

function testCase(context, name, callback) {
  context.caseName = name;
  context.command = "filesystem assertion";
  callback();
  console.log(`ok Part ${context.part} ${name}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listYaml(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
}

function treeHash(root) {
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
        entries.push({ path: rel, type: "file", hash: fileHash(full) });
      } else {
        entries.push({ path: rel, type: "other" });
      }
    }
  }
  walk(root, "");
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function migrationLineCount(text) {
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function outsideManagedText(text) {
  const begin = text.indexOf("<!-- kg:begin -->");
  const end = text.indexOf("<!-- kg:end -->");
  const beginLine = text.lastIndexOf("\n", begin) + 1;
  const endNewline = text.indexOf("\n", end);
  const endLine = endNewline < 0 ? text.length : endNewline + 1;
  return text.slice(0, beginLine) + text.slice(endLine);
}

function countHeading(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`^## ${escaped}[ \\t]*$`, "gm"))].length;
}

function cloneMigrationProject(destination) {
  fs.cpSync(MIGRATION_FIXTURE, destination, { recursive: true });
}

function setupMigrationCase(context, name) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  cloneMigrationProject(project);
  return {
    caseRoot,
    project,
    artifacts,
    plan: path.join(artifacts, "migration-plan.json"),
  };
}

function generateMigrationPlan(context, setup) {
  const detection = runNode(context, MIGRATION_DETECT, ["--root", setup.project], {
    cwd: setup.project,
  });
  const detected = JSON.parse(detection.stdout);
  ensure(context, detected.classification === "v1", "migration detector did not classify the fixture as v1");
  const generated = runNode(
    context,
    MIGRATION_EXECUTE,
    ["--root", setup.project, "--output", setup.plan, "--now", MIGRATION_NOW],
    { cwd: setup.project },
  );
  const plan = JSON.parse(generated.stdout);
  ensure(context, JSON.stringify(plan) === JSON.stringify(readJson(setup.plan)), "stdout plan differs from saved plan");
  return plan;
}

function executeMigration(context, setup, root = setup.project) {
  const executed = runNode(
    context,
    MIGRATION_EXECUTE,
    ["--root", root, "--execute", "--plan", setup.plan],
    { cwd: root },
  );
  return JSON.parse(executed.stdout);
}

function assertMigrationSkills(context, project) {
  const agentsSkills = path.join(project, ".agents", "skills");
  const kgNames = fs
    .readdirSync(agentsSkills, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("kg-"))
    .sort();
  ensure(context, JSON.stringify(kgNames) === JSON.stringify([...KG_SKILLS].sort()), "installed kg skill set is not exactly seven");
  ensure(context, fs.existsSync(path.join(agentsSkills, "custom-tool", "sentinel.txt")), "non-kg skill sentinel was removed");
  ensure(
    context,
    treeHash(path.join(agentsSkills, "kg-docs")) === treeHash(path.join(ROOT, "skills", "kg-docs")),
    "installed kg-docs does not match the complete source skill",
  );
  ensure(
    context,
    fs.existsSync(path.join(agentsSkills, "kg-docs", "scripts", "lib", "protocol.mjs")),
    "installed kg-docs lost its vendored scripts/lib",
  );

  const claudeSkills = path.join(project, ".claude", "skills");
  const claudeNames = fs
    .readdirSync(claudeSkills, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith("kg-"))
    .map((entry) => entry.name)
    .sort();
  ensure(context, JSON.stringify(claudeNames) === JSON.stringify([...KG_SKILLS].sort()), "Claude skill set is not exactly seven");
  for (const name of KG_SKILLS) {
    const link = path.join(claudeSkills, name);
    ensure(context, fs.lstatSync(link).isSymbolicLink(), `Claude skill is not a symlink: ${name}`);
    ensure(
      context,
      fs.realpathSync(link) === fs.realpathSync(path.join(agentsSkills, name)),
      `Claude skill link does not resolve to the canonical copy: ${name}`,
    );
  }
}

function runInstalledSkillSelfChecks(context, project) {
  const keyScripts = {
    "kg-init": "scripts/migrate-v1.mjs",
    "kg-observe": "scripts/add-observation.mjs",
    "kg-compile": "scripts/archive-observations.mjs",
    "kg-scan": "scripts/scan-inventory.mjs",
    "kg-kickoff": "scripts/gather-context.mjs",
    "kg-spec": "scripts/produce-spec.mjs",
    "kg-docs": "scripts/inventory.mjs",
  };
  for (const [name, relative] of Object.entries(keyScripts)) {
    const skillRoot = path.join(project, ".agents", "skills", name);
    runNode(context, "--check", [path.join(skillRoot, relative)], { cwd: project });
    const resolverUrl = pathToFileURL(path.join(skillRoot, "scripts", "_lib.mjs")).href;
    runNode(
      context,
      "--input-type=module",
      ["--eval", `await import(${JSON.stringify(resolverUrl)})`],
      { cwd: project },
    );
  }
}

function runPart1(context) {
  testCase(context, "migration_v1_minimal_preserves_assets", () => {
    const setup = setupMigrationCase(context, "positive");
    const originalTree = treeHash(setup.project);
    const originalConfig = fs.readFileSync(path.join(setup.project, ".kg", "config.yaml"));
    const originalAgents = fs.readFileSync(path.join(setup.project, "AGENTS.md"), "utf8");
    const oldSkillSnapshot = path.join(setup.artifacts, "legacy-kg-init");
    fs.cpSync(path.join(setup.project, ".agents", "skills", "kg-init"), oldSkillSnapshot, { recursive: true });
    const preservedPaths = [
      ".kg/observations/OBS-20260731-002.yaml",
      ".kg/observations/processed/OBS-20260730-001.yaml",
      ".kg/queue/Q-20260731-001.yaml",
      ".kg/reports/compile-20260731.md",
      ".kg/unknown-sentinel.bin",
      "knowledge/KN-0001-migration-preservation.md",
      "docs/README.md",
      "docs/accepted-migration-contract.md",
      ".agents/skills/custom-tool/sentinel.txt",
    ];
    const preservedHashes = Object.fromEntries(
      preservedPaths.map((relative) => [relative, fileHash(path.join(setup.project, relative))]),
    );

    const plan = generateMigrationPlan(context, setup);
    ensure(context, treeHash(setup.project) === originalTree, "Phase 0 changed the migration fixture tree");
    ensure(context, plan.kind === "kg.migration_plan" && plan.version === 1, "migration plan kind or version mismatch");
    ensure(context, plan.detection.classification === "v1", "migration plan did not bind the v1 detection");
    ensure(context, plan.queue.items.length === 1, "compatible queue item was not represented in the plan");
    ensure(
      context,
      plan.queue.items[0].strategy === "preserve_compatible_v1_record",
      "compatible queue item preservation strategy mismatch",
    );
    const operationPaths = plan.operations.map((operation) => operation.path);
    ensure(context, new Set(operationPaths).size === operationPaths.length, "migration plan contains duplicate paths");
    for (const required of [".kg/config.v1.bak", ".kg/config.yaml", "AGENTS.md"]) {
      ensure(context, operationPaths.includes(required), `migration plan is missing ${required}`);
    }
    for (const operation of plan.operations) {
      ensure(context, typeof operation.action === "string", `plan action missing for ${operation.path}`);
      ensure(context, typeof operation.preserve === "string", `plan preservation strategy missing for ${operation.path}`);
      ensure(context, operation.before?.type, `plan before fingerprint missing for ${operation.path}`);
      ensure(context, operation.after?.type, `plan after fingerprint missing for ${operation.path}`);
    }

    const firstResult = executeMigration(context, setup);
    ensure(context, firstResult.status === "complete", "migration result is not complete");
    ensure(context, firstResult.advisories.length === 0, "bounded fixture unexpectedly exceeded the AGENTS line budget");
    ensure(
      context,
      fs.readFileSync(path.join(setup.project, ".kg", "config.v1.bak")).equals(originalConfig),
      "config.v1.bak is not byte-identical to the v1 config",
    );
    const config = fs.readFileSync(path.join(setup.project, ".kg", "config.yaml"), "utf8");
    for (const field of ["kind: kg.config", "version: 2", "observation_threshold: 3", "skills_path: .agents/skills"]) {
      ensure(context, config.includes(field), `v2 config is missing ${field}`);
    }
    ensure(context, !config.includes("agents_block_budget_lines"), "v2 config retained the v1 AGENTS budget");
    for (const [relative, expected] of Object.entries(preservedHashes)) {
      ensure(context, fileHash(path.join(setup.project, relative)) === expected, `migration changed preserved asset ${relative}`);
    }
    const knowledgeText = fs.readFileSync(
      path.join(setup.project, "knowledge", "KN-0001-migration-preservation.md"),
      "utf8",
    );
    ensure(context, !knowledgeText.includes("source_obs_ids:"), "migration bulk-added source_obs_ids to v1 knowledge");
    ensure(context, !knowledgeText.includes("carrier_refs:"), "migration bulk-added carrier_refs to v1 knowledge");

    const agents = fs.readFileSync(path.join(setup.project, "AGENTS.md"), "utf8");
    ensure(context, agents.startsWith(outsideManagedText(originalAgents)), "manual AGENTS content was not preserved byte for byte");
    ensure(context, !agents.includes("<!-- kg:begin -->") && !agents.includes("<!-- kg:end -->"), "v1 AGENTS markers remain");
    ensure(context, countHeading(agents, "硬规则") === 1, "AGENTS hard-rule section count mismatch");
    ensure(context, countHeading(agents, "Commands") === 1, "AGENTS Commands section count mismatch");
    ensure(context, countHeading(agents, "使用 kg") === 1, "AGENTS kg usage section count mismatch");
    const generatedBashBlocks = [...agents.matchAll(/^```bash$\n([\s\S]*?)^```$/gm)];
    ensure(context, generatedBashBlocks.length === 1, "AGENTS Commands bash block count mismatch");
    ensure(
      context,
      JSON.stringify(generatedBashBlocks[0][1].trimEnd().split("\n")) ===
        JSON.stringify([
          "# 构建",
          "<YOUR_BUILD_COMMAND>",
          "# 测试",
          "<YOUR_TEST_COMMAND>",
          "# Lint",
          "<YOUR_LINT_COMMAND>",
        ]),
      "AGENTS generated Commands block structure mismatch",
    );
    for (const skill of ["kg-kickoff", "kg-spec", "kg-observe"]) {
      ensure(context, agents.includes(`\`${skill}\``), `AGENTS kg usage section is missing ${skill}`);
    }
    ensure(context, migrationLineCount(agents) <= 30, "bounded fixture AGENTS.md exceeds 30 lines");

    assertMigrationSkills(context, setup.project);
    ensure(context, /^@AGENTS\.md$/m.test(fs.readFileSync(path.join(setup.project, "CLAUDE.md"), "utf8")), "CLAUDE.md import missing");
    for (const relative of [
      ".kg/migration",
      "docs/specs",
      "harness/artifacts",
      "harness/skills",
      "harness/scripts",
    ]) {
      ensure(context, fs.statSync(path.join(setup.project, relative)).isDirectory(), `v2 directory missing: ${relative}`);
    }
    for (const relative of [
      "docs/glossary.md",
      "docs/development.md",
      "docs/architecture/overview.md",
      "docs/decisions/0000-template.md",
      "docs/rfcs/0000-template.md",
    ]) {
      ensure(context, !fs.existsSync(path.join(setup.project, relative)), `migration eagerly created ${relative}`);
    }

    const detectionAfter = runNode(context, MIGRATION_DETECT, ["--root", setup.project], { cwd: setup.project });
    ensure(context, JSON.parse(detectionAfter.stdout).classification === "v2", "post-migration detector did not report v2");
    runInstalledSkillSelfChecks(context, setup.project);
    runNode(context, PROTOCOL_SELF_CHECK, [], { cwd: ROOT });
    runNode(context, SYNC_VENDORED, ["--check"], { cwd: ROOT });

    const stableTree = treeHash(setup.project);
    const secondResult = executeMigration(context, setup);
    ensure(context, secondResult.applied.length === 0, "second execution of the same plan applied extra changes");
    ensure(context, treeHash(setup.project) === stableTree, "second execution changed the final file tree");

    const installedInit = path.join(setup.project, ".agents", "skills", "kg-init");
    fs.rmSync(installedInit, { recursive: true, force: true });
    fs.cpSync(oldSkillSnapshot, installedInit, { recursive: true });
    const resumed = executeMigration(context, setup);
    ensure(context, resumed.applied.includes(".agents/skills/kg-init"), "mixed-state resume did not repair the pending skill");
    ensure(context, treeHash(setup.project) === stableTree, "mixed-state resume did not restore the completed tree");
  });

  testCase(context, "existing_commands_and_normal_non_main_variants", () => {
    const setup = setupMigrationCase(context, "existing-commands");
    fs.rmSync(path.join(setup.project, ".agents", "skills", "kg-compile"), { recursive: true, force: true });
    fs.rmSync(path.join(setup.project, ".agents", "skills", "kg-scan"), { recursive: true, force: true });
    fs.rmSync(path.join(setup.project, "knowledge", "KN-0001-migration-preservation.md"));
    fs.cpSync(
      path.join(ROOT, "skills", "kg-docs"),
      path.join(setup.project, ".agents", "skills", "kg-docs"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(setup.project, ".kg", "config.yaml"),
      path.join(setup.project, ".kg", "config.v1.bak"),
    );
    const installedDocsBefore = treeHash(path.join(setup.project, ".agents", "skills", "kg-docs"));
    const commandsAgents = [
      "# Existing Commands fixture",
      "",
      "Human content before the managed block.",
      "",
      "<!-- kg:begin -->",
      "legacy managed content",
      "<!-- kg:end -->",
      "",
      "## Commands",
      "",
      "```bash",
      "# Build",
      "npm run build",
      "# Test",
      "npm test",
      "# Lint",
      "npm run lint",
      "```",
      "",
      "Human content after Commands.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(setup.project, "AGENTS.md"), commandsAgents);

    const plan = generateMigrationPlan(context, setup);
    ensure(
      context,
      !plan.operations.some((operation) => operation.path === ".agents/skills/kg-docs"),
      "source-identical kg-docs was scheduled for destructive replacement",
    );
    ensure(
      context,
      !plan.operations.some((operation) => operation.path === ".kg/config.v1.bak"),
      "byte-identical recovery backup was scheduled for replacement",
    );
    ensure(context, plan.agents.injected_commands === false, "human Commands section was not detected");
    executeMigration(context, setup);
    const agents = fs.readFileSync(path.join(setup.project, "AGENTS.md"), "utf8");
    ensure(context, countHeading(agents, "Commands") === 1, "migration duplicated the human Commands section");
    const expectedManual = outsideManagedText(commandsAgents);
    const expectedCommandIndex = expectedManual.indexOf("## Commands");
    const actualHardIndex = agents.indexOf("## 硬规则");
    const actualCommandIndex = agents.indexOf("## Commands");
    ensure(
      context,
      agents.slice(0, actualHardIndex) === expectedManual.slice(0, expectedCommandIndex),
      "human bytes before an existing Commands section were changed",
    );
    ensure(
      context,
      agents.slice(actualCommandIndex, actualCommandIndex + expectedManual.slice(expectedCommandIndex).length) ===
        expectedManual.slice(expectedCommandIndex),
      "human bytes from an existing Commands section onward were changed",
    );
    const humanBashBlocks = [...agents.matchAll(/^```bash$\n([\s\S]*?)^```$/gm)];
    ensure(context, humanBashBlocks.length === 1, "human Commands bash block count mismatch");
    ensure(
      context,
      JSON.stringify(humanBashBlocks[0][1].trimEnd().split("\n")) ===
        JSON.stringify(["# Build", "npm run build", "# Test", "npm test", "# Lint", "npm run lint"]),
      "human Commands block bytes were changed or placeholders were injected",
    );
    ensure(context, countHeading(agents, "硬规则") === 1 && countHeading(agents, "使用 kg") === 1, "v2 companion sections missing");
    ensure(context, migrationLineCount(agents) <= 30, "existing Commands fixture exceeds the bounded 30-line budget");
    ensure(
      context,
      treeHash(path.join(setup.project, ".agents", "skills", "kg-docs")) === installedDocsBefore,
      "preinstalled complete kg-docs changed during migration",
    );
    ensure(context, fs.readdirSync(path.join(setup.project, "knowledge")).length === 0, "empty knowledge directory was populated");
    ensure(context, fs.existsSync(path.join(setup.project, "CLAUDE.md")), "Claude marker without CLAUDE.md was not wired");
    assertMigrationSkills(context, setup.project);
  });

  testCase(context, "long_manual_agents_content_is_advisory", () => {
    const setup = setupMigrationCase(context, "agents-advisory");
    const humanLines = Array.from({ length: 31 }, (_, index) => `Human instruction ${index + 1}.`);
    const longAgents = [
      "# Long human instructions",
      ...humanLines,
      "<!-- kg:begin -->",
      "legacy managed content",
      "<!-- kg:end -->",
      "Human tail.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(setup.project, "AGENTS.md"), longAgents);
    const plan = generateMigrationPlan(context, setup);
    ensure(context, plan.advisories.length === 1, "over-budget AGENTS plan did not emit one advisory");
    ensure(context, plan.advisories[0].code === "agents_line_budget_exceeded", "AGENTS advisory code mismatch");
    const result = executeMigration(context, setup);
    ensure(context, result.advisories.length === 1, "execution report omitted the AGENTS advisory");
    const migrated = fs.readFileSync(path.join(setup.project, "AGENTS.md"), "utf8");
    ensure(context, migrationLineCount(migrated) > 30, "long human fixture was unexpectedly shortened");
    for (const line of humanLines) ensure(context, migrated.includes(line), `long human content was removed: ${line}`);
  });

  testCase(context, "reject_unmappable_queue_items_with_complete_report", () => {
    const setup = setupMigrationCase(context, "unmappable-queue");
    fs.writeFileSync(
      path.join(setup.project, ".kg", "queue", "Q-20260731-002.yaml"),
      "kind: proposal\ncategory: legacy_unknown\nclaim: unmappable\n",
    );
    fs.writeFileSync(
      path.join(setup.project, ".kg", "queue", "Q-20260731-003.yaml"),
      "kind: [unterminated\n",
    );
    const before = treeHash(setup.project);
    const rejected = runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", setup.project, "--output", setup.plan, "--now", MIGRATION_NOW],
      { cwd: setup.project, expectFailure: true },
    );
    const report = JSON.parse(rejected.stderr);
    ensure(context, report.kind === "kg.migration_error_report", "queue failure report kind mismatch");
    ensure(context, report.items.length === 2, "queue failure report did not include every unmappable item");
    ensure(
      context,
      JSON.stringify(report.items.map((item) => item.reason).sort()) ===
        JSON.stringify(["invalid_format", "unmappable_category"]),
      "queue failure reasons are incomplete",
    );
    ensure(
      context,
      report.items.every((item) => item.recommendation === "M3_quarantine" && item.path.startsWith(".kg/queue/")),
      "queue failure report omitted path or M3 disposition",
    );
    ensure(context, treeHash(setup.project) === before, "queue preflight failure changed the host");
    ensure(context, !fs.existsSync(path.join(setup.project, ".kg", "config.v1.bak")), "queue failure created a backup");
  });

  testCase(context, "reject_malformed_managed_markers_and_commands", () => {
    const variants = {
      "one-anchor": "# Fixture\n<!-- kg:begin -->\nlegacy\n",
      nested: "# Fixture\n<!-- kg:begin -->\n<!-- kg:begin -->\nlegacy\n<!-- kg:end -->\n",
      "two-pairs": [
        "# Fixture",
        "<!-- kg:begin -->",
        "one",
        "<!-- kg:end -->",
        "<!-- kg:begin -->",
        "two",
        "<!-- kg:end -->",
        "",
      ].join("\n"),
      "commands-without-bash": [
        "# Fixture",
        "<!-- kg:begin -->",
        "legacy",
        "<!-- kg:end -->",
        "## Commands",
        "",
        "npm test",
        "",
      ].join("\n"),
      "commands-with-wrong-labels": [
        "# Fixture",
        "<!-- kg:begin -->",
        "legacy",
        "<!-- kg:end -->",
        "## Commands",
        "",
        "```bash",
        "# one",
        "npm run build",
        "# two",
        "npm test",
        "# three",
        "npm run lint",
        "```",
        "",
      ].join("\n"),
    };
    for (const [name, text] of Object.entries(variants)) {
      const setup = setupMigrationCase(context, `bad-agents-${name}`);
      fs.writeFileSync(path.join(setup.project, "AGENTS.md"), text);
      const before = treeHash(setup.project);
      runNode(
        context,
        MIGRATION_EXECUTE,
        ["--root", setup.project, "--output", setup.plan, "--now", MIGRATION_NOW],
        { cwd: setup.project, expectFailure: true },
      );
      ensure(context, treeHash(setup.project) === before, `${name} AGENTS failure changed the host`);
      ensure(context, !fs.existsSync(path.join(setup.project, ".kg", "config.v1.bak")), `${name} failure created a backup`);
    }
  });

  testCase(context, "reject_root_alias_source_alias_and_input_drift", () => {
    const rootPlan = setupMigrationCase(context, "root-mismatch-plan");
    generateMigrationPlan(context, rootPlan);
    const other = setupMigrationCase(context, "root-mismatch-other");
    const planHostBefore = treeHash(rootPlan.project);
    const otherBefore = treeHash(other.project);
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", other.project, "--execute", "--plan", rootPlan.plan],
      { cwd: other.project, expectFailure: true },
    );
    ensure(context, treeHash(rootPlan.project) === planHostBefore, "root mismatch changed the plan host");
    ensure(context, treeHash(other.project) === otherBefore, "root mismatch changed the execute host");

    const alias = setupMigrationCase(context, "source-alias");
    fs.rmSync(path.join(alias.project, ".agents", "skills"), { recursive: true, force: true });
    fs.symlinkSync(path.join(ROOT, "skills"), path.join(alias.project, ".agents", "skills"));
    const aliasBefore = treeHash(alias.project);
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", alias.project, "--output", alias.plan, "--now", MIGRATION_NOW],
      { cwd: alias.project, expectFailure: true },
    );
    ensure(context, treeHash(alias.project) === aliasBefore, "source alias failure changed the host");

    const drift = setupMigrationCase(context, "input-drift");
    generateMigrationPlan(context, drift);
    fs.appendFileSync(path.join(drift.project, "AGENTS.md"), "\nHuman edit after plan generation.\n");
    const driftBeforeExecute = treeHash(drift.project);
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", drift.project, "--execute", "--plan", drift.plan],
      { cwd: drift.project, expectFailure: true },
    );
    ensure(context, treeHash(drift.project) === driftBeforeExecute, "input drift failure changed the host");
    ensure(context, !fs.existsSync(path.join(drift.project, ".kg", "config.v1.bak")), "input drift created a backup");
  });

  testCase(context, "reject_incomplete_skill_source_pre_mutation", () => {
    const setup = setupMigrationCase(context, "bad-source");
    const before = treeHash(setup.project);

    // Create a temporary skills source missing scripts/lib/ in one skill
    const badSource = path.join(setup.caseRoot, "bad-skills");
    fs.cpSync(path.join(ROOT, "skills"), badSource, { recursive: true });
    fs.rmSync(path.join(badSource, "kg-observe", "scripts", "lib"), { recursive: true, force: true });

    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", setup.project, "--output", setup.plan, "--skills-source", badSource, "--now", MIGRATION_NOW],
      { cwd: setup.project, expectFailure: true },
    );
    ensure(context, treeHash(setup.project) === before, "incomplete skill source failure changed the host");
    ensure(context, !fs.existsSync(path.join(setup.project, ".kg", "config.v1.bak")), "incomplete source failure created a backup");
  });

  testCase(context, "cleanup_orphan_stage_directories_from_prior_plan", () => {
    const setup = setupMigrationCase(context, "orphan-cleanup");

    // Plant fake orphan stage/backup with a synthetic plan ID that will
    // never match a real plan.
    const skillsDir = path.join(setup.project, ".agents", "skills");
    const fakePlanId = "MIG-0000000000000000";
    const fakeSkill = "kg-init";

    const stageRelative = `.agents/skills/.kg-migration-stage-${fakePlanId}-${fakeSkill}`;
    const backupRelative = `.agents/skills/.kg-migration-backup-${fakePlanId}-${fakeSkill}`;
    const orphanStage = path.join(setup.project, stageRelative);
    const orphanBackup = path.join(setup.project, backupRelative);
    fs.mkdirSync(orphanStage, { recursive: true });
    fs.writeFileSync(path.join(orphanStage, "sentinel.txt"), "orphan stage");
    fs.mkdirSync(orphanBackup, { recursive: true });
    fs.writeFileSync(path.join(orphanBackup, "sentinel.txt"), "orphan backup");

    const docsReadmeHash = fileHash(path.join(setup.project, "docs", "README.md"));
    const expectedOrphans = JSON.stringify([backupRelative, stageRelative].sort());

    const plan = generateMigrationPlan(context, setup);

    // The removal is a plan-time decision, so the plan must claim the
    // scaffolding and the preserved set must not also claim it.
    const claimed = plan.orphans.map((orphan) => orphan.path).sort();
    ensure(
      context,
      JSON.stringify(claimed) === expectedOrphans,
      `plan did not claim the scaffolding; got ${JSON.stringify(claimed)}`,
    );
    const preservedPaths = plan.preserved.map((item) => item.path);
    ensure(
      context,
      !preservedPaths.some((item) => item.startsWith(".agents/skills/.kg-migration-")),
      "preserved set still claims migration scaffolding",
    );

    const result = executeMigration(context, setup);
    ensure(context, result.status === "complete", "migration with orphan cleanup did not complete");
    ensure(
      context,
      JSON.stringify([...result.cleaned_orphans].sort()) === expectedOrphans,
      `cleanup report mismatch; got ${JSON.stringify(result.cleaned_orphans)}`,
    );
    ensure(context, !fs.existsSync(orphanStage), "orphan stage was not removed");
    ensure(context, !fs.existsSync(orphanBackup), "orphan backup was not removed");
    ensure(
      context,
      fileHash(path.join(setup.project, "docs", "README.md")) === docsReadmeHash,
      "preserved asset changed while cleaning scaffolding",
    );

    // Re-running the same plan must not trip Phase 2 on the now-absent
    // scaffolding the plan still lists.
    const second = executeMigration(context, setup);
    ensure(context, second.status === "complete", "re-run after orphan cleanup did not complete");
    ensure(
      context,
      second.cleaned_orphans.length === 0,
      `re-run re-reported cleanup; got ${JSON.stringify(second.cleaned_orphans)}`,
    );
  });
}

function cloneBootstrapProject(destination, { hazards = false } = {}) {
  fs.cpSync(path.join(BOOTSTRAP_FIXTURE, "host"), destination, { recursive: true });
  if (hazards) {
    fs.writeFileSync(path.join(destination, "binary.png"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(destination, "large.txt"), "x".repeat(2048));
    fs.symlinkSync(path.join(destination, "src"), path.join(destination, "linked-src"));
  }
}

function setupBootstrapCase(context, name, inventoryArgs = []) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  cloneBootstrapProject(project, { hazards: true });
  const inventory = path.join(artifacts, "repository-inventory.json");
  const plan = path.join(artifacts, "bootstrap-plan.json");
  fs.copyFileSync(path.join(BOOTSTRAP_FIXTURE, "plan.valid.json"), plan);
  runNode(
    context,
    DOCS_INVENTORY,
    ["--root", project, "--output", inventory, "--now", FIXED_NOW, "--max-bytes", "512", ...inventoryArgs],
    { cwd: project },
  );
  return { caseRoot, project, artifacts, inventory, plan };
}

function expectBootstrapFailure(context, setup, planValue) {
  writeJson(setup.plan, planValue);
  runNode(
    context,
    DOCS_BOOTSTRAP,
    ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
    { cwd: setup.project, expectFailure: true },
  );
  ensure(context, !fs.existsSync(path.join(setup.project, "docs", "architecture", "overview.md")), "failed bootstrap left a target");
}

function factSourcesFromDocument(text) {
  return [...text.matchAll(/^<!-- kg:fact-source (.+) -->$/gm)].map((match) => JSON.parse(match[1]));
}

function runPart2(context) {
  testCase(context, "positive_inventory_plan_render_chain", () => {
    const setup = setupBootstrapCase(context, "positive");
    const inventory = readJson(setup.inventory);
    const safePaths = inventory.files.map((file) => file.path);
    ensure(context, inventory.kind === "kg.repository_inventory", "inventory kind mismatch");
    ensure(context, inventory.static_only === true, "inventory is not static_only");
    ensure(context, inventory.generated_at === FIXED_NOW, "inventory test clock mismatch");
    ensure(context, inventory.truncated === false, "positive inventory unexpectedly truncated");
    for (const expected of ["package.json", "src/server.mjs", "src/order-service.mjs", "should-not-run.mjs"]) {
      ensure(context, safePaths.includes(expected), `safe file missing from inventory: ${expected}`);
    }
    for (const forbidden of [
      ".env",
      ".KG/uncompiled.yaml",
      "mixed/.kG/mixed-case.yaml",
      "secrets/notes.txt",
      "binary.png",
      "large.txt",
      "linked-src",
    ]) {
      ensure(
        context,
        !safePaths.some((item) => item === forbidden || item.startsWith(`${forbidden}/`)),
        `excluded path entered inventory: ${forbidden}`,
      );
    }
    ensure(context, inventory.stats.excluded_kg_directories >= 2, "mixed-case .kg directories were not counted");
    ensure(context, inventory.stats.excluded_sensitive_files >= 1, "secret file was not excluded");
    ensure(context, inventory.stats.excluded_sensitive_directories >= 1, "secret directory was not excluded");
    ensure(context, inventory.stats.excluded_binary_files >= 1, "binary file was not excluded");
    ensure(context, inventory.stats.excluded_oversized_files >= 1, "oversized file was not excluded");
    ensure(context, inventory.stats.excluded_symlinks >= 1, "symlink was not excluded");
    ensure(context, inventory.evidence.every((item) => item.line_start >= 1 && item.line_end >= item.line_start), "inventory evidence line range invalid");
    ensure(context, !fs.existsSync(path.join(setup.project, "should-not-run.executed")), "inventory executed should-not-run code");

    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
      { cwd: setup.project },
    );
    const target = path.join(setup.project, "docs", "architecture", "overview.md");
    const document = fs.readFileSync(target, "utf8");
    for (const field of ["kind: kg.project_document", "doc_type: architecture", "status: draft"]) {
      ensure(context, document.includes(field), `architecture frontmatter missing ${field}`);
    }
    for (const heading of [
      "## 上下文与边界（C4 System Context）",
      "## 构建块视图（C4 Container）",
      "## 运行时视图",
      "## 部署视图",
    ]) {
      ensure(context, document.includes(heading), `architecture section missing ${heading}`);
    }
    const plan = readJson(setup.plan);
    ensure(
      context,
      JSON.stringify(factSourcesFromDocument(document)) === JSON.stringify(plan.observed_facts.map((fact) => fact.source)),
      "rendered fact sources differ from bootstrap plan",
    );
    ensure(context, !fs.existsSync(path.join(setup.project, "should-not-run.executed")), "bootstrap executed should-not-run code");

    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--check", "--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
      { cwd: setup.project },
    );
    const validation = runNode(context, DOCS_VALIDATE, [target], {
      cwd: setup.project,
      env: { KG_ROOT: setup.project },
    });
    ensure(context, validation.stdout.includes("1/1 registered project document(s) valid"), "project document validator did not pass");
  });

  testCase(context, "reject_unknown_and_script_owned_plan_fields", () => {
    const setup = setupBootstrapCase(context, "unknown-plan");
    const plan = readJson(setup.plan);
    plan.status = "accepted";
    plan.created_at = FIXED_NOW;
    expectBootstrapFailure(context, setup, plan);
  });

  testCase(context, "reject_missing_uninventoried_and_out_of_range_sources", () => {
    for (const variant of ["missing", "uninventoried", "out-of-range", "symlink", "kg-case"]) {
      const setup = setupBootstrapCase(context, `bad-source-${variant}`);
      const plan = readJson(setup.plan);
      if (variant === "missing") delete plan.observed_facts[0].source;
      if (variant === "uninventoried") plan.observed_facts[0].source.path = "src/missing.mjs";
      if (variant === "out-of-range") plan.observed_facts[0].source.line_end = 999;
      if (variant === "symlink") plan.observed_facts[0].source.path = "linked-src/server.mjs";
      if (variant === "kg-case") plan.observed_facts[0].source.path = ".KG/uncompiled.yaml";
      expectBootstrapFailure(context, setup, plan);
    }
  });

  testCase(context, "reject_truncation_without_coverage_limitation", () => {
    const setup = setupBootstrapCase(context, "truncated", ["--max-files", "1"]);
    const inventory = readJson(setup.inventory);
    ensure(context, inventory.truncated === true, "max-files inventory did not report truncation");
    const plan = readJson(setup.plan);
    plan.coverage_limitations = [];
    expectBootstrapFailure(context, setup, plan);
  });

  testCase(context, "reject_inference_without_confidence_or_evidence", () => {
    for (const variant of ["confidence", "sources"]) {
      const setup = setupBootstrapCase(context, `bad-inference-${variant}`);
      const plan = readJson(setup.plan);
      if (variant === "confidence") delete plan.inferences[0].confidence;
      if (variant === "sources") plan.inferences[0].sources = [];
      expectBootstrapFailure(context, setup, plan);
    }
  });

  testCase(context, "reject_source_drift_after_inventory", () => {
    const setup = setupBootstrapCase(context, "source-drift");
    fs.appendFileSync(path.join(setup.project, "src", "server.mjs"), "\n// changed after inventory\n");
    expectBootstrapFailure(context, setup, readJson(setup.plan));
  });

  testCase(context, "reject_existing_target_without_overwrite", () => {
    const setup = setupBootstrapCase(context, "existing-target");
    const target = path.join(setup.project, "docs", "architecture", "overview.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "human-authored\n");
    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
      { cwd: setup.project, expectFailure: true },
    );
    ensure(context, fs.readFileSync(target, "utf8") === "human-authored\n", "existing architecture target was modified");
  });

  testCase(context, "gb_evaluator_requires_tool_chain_and_rejects_denials", () => {
    const fixture = path.join(ROOT, "scripts", "fixtures", "m2", "bootstrap.fixture.json");
    const passingArtifacts = path.join(context.root, "gb-evaluator-pass");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", fixture, "--artifacts", passingArtifacts],
      { cwd: ROOT, env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_RUNNER } },
    );
    const passingResult = readJson(path.join(passingArtifacts, "result.json"));
    ensure(context, passingResult.pass === true, "G-B evaluator fixture did not pass");
    const prompt = fs.readFileSync(path.join(passingArtifacts, "actual-prompt.txt"), "utf8");
    ensure(context, !prompt.includes("The application exposes an order lookup route"), "fixture oracle leaked into runner prompt");
    ensure(context, readJson(path.join(passingArtifacts, "tool-events.json")).length === 3, "tool events were not saved");

    const deniedArtifacts = path.join(context.root, "gb-evaluator-denied");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", fixture, "--artifacts", deniedArtifacts],
      {
        cwd: ROOT,
        env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_RUNNER, KG_FAKE_DENIAL: "1" },
        expectFailure: true,
      },
    );
    const deniedResult = readJson(path.join(deniedArtifacts, "result.json"));
    ensure(context, deniedResult.pass === false, "permission denial did not invalidate G-B");
    ensure(context, deniedResult.failures.permissions.length === 1, "permission denial evidence missing");

    const missingToolArtifacts = path.join(context.root, "gb-evaluator-missing-tool");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", fixture, "--artifacts", missingToolArtifacts],
      {
        cwd: ROOT,
        env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_RUNNER, KG_FAKE_MISSING_TOOL: "1" },
        expectFailure: true,
      },
    );
    const missingToolResult = readJson(path.join(missingToolArtifacts, "result.json"));
    ensure(context, missingToolResult.pass === false, "missing inventory tool event did not invalidate G-B");
    ensure(
      context,
      missingToolResult.failures.tools.some((failure) => failure.includes("inventory.mjs tool event missing")),
      "missing inventory tool event failure was not reported",
    );

    const shellPlanArtifacts = path.join(context.root, "gb-evaluator-shell-plan");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", fixture, "--artifacts", shellPlanArtifacts],
      {
        cwd: ROOT,
        env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_RUNNER, KG_FAKE_SHELL_PLAN: "1" },
        expectFailure: true,
      },
    );
    const shellPlanResult = readJson(path.join(shellPlanArtifacts, "result.json"));
    ensure(context, shellPlanResult.pass === false, "Bash plan event did not invalidate G-B");
    ensure(
      context,
      shellPlanResult.failures.tools.some((failure) => failure.includes("JSON plan submission tool event missing")),
      "Bash plan event was accepted as plan submission",
    );
  });
}

function setupObservationHost(context, name, { includeLegacy = false, includeKnowledge = true } = {}) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.mkdirSync(path.join(project, ".kg", "observations", "processed"), { recursive: true });
  fs.mkdirSync(path.join(project, "knowledge"), { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(project, ".kg", "config.yaml"), "observation_threshold: 2\nskills_path: .agents/skills\n");
  if (includeLegacy) {
    fs.copyFileSync(
      path.join(OBSERVE_FIXTURE, "v1-observation.yaml"),
      path.join(project, ".kg", "observations", "processed", "OBS-20260730-001.yaml"),
    );
  }
  if (includeKnowledge) {
    fs.cpSync(path.join(OBSERVE_FIXTURE, "knowledge"), path.join(project, "knowledge"), { recursive: true });
  }
  return { caseRoot, project, artifacts };
}

function observationEnv(project) {
  return { KG_ROOT: project };
}

function writeAgentDraft(file, overrides = {}) {
  const base = readJson(path.join(OBSERVE_FIXTURE, "agent-draft.json"));
  writeJson(file, { ...base, ...overrides });
}

function assertCanonicalObservation(context, text, { compiled = false } = {}) {
  const fields = ["id:", "at:", "source:", "claim:", "context:", "evidence:", "urgency:"];
  if (compiled) fields.push("compiled_to_kn:");
  let previous = -1;
  for (const field of fields) {
    const index = text.indexOf(field);
    ensure(context, index > previous, `observation field order invalid at ${field}`);
    previous = index;
  }
  if (!compiled) ensure(context, !text.includes("compiled_to_kn:"), "pending observation contains compiled_to_kn");
}

function canonicalV1ObservationText() {
  return [
    "id: OBS-20260730-001",
    "at: 2026-07-30T12:00:00Z",
    "source: task_outcome",
    'claim: "A v1 observation remains valid after the schema extension."',
    "context:",
    "  task: v1-preservation",
    '  paths: ["src/**"]',
    "evidence:",
    '  - { type: test, ref: "legacy observation validator fixture" }',
    "urgency: batch",
    "",
  ].join("\n");
}

function runPart3(context) {
  testCase(context, "v1_validation_json_write_threshold_and_archive", () => {
    const setup = setupObservationHost(context, "positive", { includeLegacy: true });
    const standaloneLegacy = path.join(setup.artifacts, "OBS-20260730-001.yaml");
    fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), standaloneLegacy);
    runNode(context, OBSERVE_VALIDATE, [standaloneLegacy], {
      cwd: setup.project,
      env: observationEnv(setup.project),
    });

    const first = runNode(
      context,
      OBSERVE_ADD,
      [path.join(OBSERVE_FIXTURE, "agent-draft.json"), "--now", FIXED_NOW],
      { cwd: setup.project, env: observationEnv(setup.project) },
    );
    ensure(context, first.stdout.includes("OBS-20260731-001"), "first observation id mismatch");
    ensure(context, first.stdout.includes("fast_track"), "human correction did not receive fast_track");
    const firstFile = path.join(setup.project, ".kg", "observations", "OBS-20260731-001.yaml");
    const firstText = fs.readFileSync(firstFile, "utf8");
    assertCanonicalObservation(context, firstText);
    ensure(context, firstText.includes("# anchors"), "hash character was not preserved");
    ensure(context, firstText.includes("docs/architecture/overview.md#L12"), "path anchor was not preserved");
    ensure(context, (firstText.match(/- \{/g) ?? []).length === 2, "multiple evidence records were not preserved");

    const batchDraft = path.join(setup.artifacts, "batch.json");
    writeAgentDraft(batchDraft, {
      source: "agent_insight",
      claim: "Batch observations retain the v1 default urgency.",
    });
    const second = runNode(context, OBSERVE_ADD, [batchDraft, "--now", FIXED_NOW], {
      cwd: setup.project,
      env: observationEnv(setup.project),
    });
    ensure(context, second.stdout.includes("OBS-20260731-002"), "second observation id mismatch");
    ensure(context, second.stdout.includes("pending observations: 2/2"), "threshold count mismatch");
    const secondFile = path.join(setup.project, ".kg", "observations", "OBS-20260731-002.yaml");
    ensure(context, fs.readFileSync(secondFile, "utf8").includes("urgency: batch"), "batch default was not preserved");
    const threshold = runNode(context, OBSERVE_THRESHOLD, [], {
      cwd: setup.project,
      env: observationEnv(setup.project),
    });
    ensure(context, threshold.stdout.includes("pending observations: 2/2"), "threshold status count missing");
    ensure(context, threshold.stdout.includes("fast_track observation(s) pending"), "fast_track reminder missing");

    const firstBeforeArchive = fs.readFileSync(firstFile, "utf8");
    runNode(
      context,
      OBSERVE_ARCHIVE,
      ["--observation", "OBS-20260731-001", "--compiled-to-kn", "KN-0001"],
      { cwd: setup.project, env: observationEnv(setup.project) },
    );
    const processed = path.join(setup.project, ".kg", "observations", "processed", "OBS-20260731-001.yaml");
    ensure(context, !fs.existsSync(firstFile), "pending observation remained after archive");
    ensure(context, fs.existsSync(processed), "processed observation missing");
    const processedText = fs.readFileSync(processed, "utf8");
    assertCanonicalObservation(context, processedText, { compiled: true });
    ensure(context, processedText.includes("compiled_to_kn: KN-0001"), "processed KN writeback missing");
    ensure(
      context,
      firstBeforeArchive.replace(/\n$/, "") === processedText.replace(/\ncompiled_to_kn: KN-0001\n$/, ""),
      "archive changed pending fields while adding compiled_to_kn",
    );
    runNode(context, OBSERVE_VALIDATE, [processed], {
      cwd: setup.project,
      env: observationEnv(setup.project),
    });

    const secondHash = fileHash(secondFile);
    const third = runNode(context, OBSERVE_ADD, [batchDraft, "--now", FIXED_NOW], {
      cwd: setup.project,
      env: observationEnv(setup.project),
    });
    ensure(context, third.stdout.includes("OBS-20260731-003"), "ID uniqueness did not span inbox and processed");
    ensure(context, fileHash(secondFile) === secondHash, "append-only writer modified an existing observation");
  });

  testCase(context, "archive_accepts_no_kn_routing_verdicts", () => {
    for (const verdict of ["no_change", "needs_human_decision"]) {
      const setup = setupObservationHost(context, `archive-verdict-${verdict}`);
      const pending = path.join(setup.project, ".kg", "observations", "OBS-20260730-001.yaml");
      const processed = path.join(setup.project, ".kg", "observations", "processed", "OBS-20260730-001.yaml");
      fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), pending);
      const archived = runNode(
        context,
        OBSERVE_ARCHIVE,
        ["--observation", "OBS-20260730-001", "--verdict", verdict],
        { cwd: setup.project, env: observationEnv(setup.project) },
      );
      ensure(context, archived.stdout.includes(`with verdict ${verdict}`), `${verdict} archive result was not reported`);
      ensure(context, !fs.existsSync(pending), `${verdict} archive left the pending observation`);
      ensure(context, fs.existsSync(processed), `${verdict} archive did not create the processed observation`);
      const processedText = fs.readFileSync(processed, "utf8");
      ensure(context, processedText === canonicalV1ObservationText(), `${verdict} processed observation is not canonical`);
      assertCanonicalObservation(context, processedText);
      runNode(context, OBSERVE_VALIDATE, [processed], {
        cwd: setup.project,
        env: observationEnv(setup.project),
      });
    }
  });

  testCase(context, "reject_unknown_id_at_and_compiled_to_kn", () => {
    for (const [variant, overrides] of [
      ["unknown", { unexpected_field: true }],
      ["id", { id: "OBS-20260731-999" }],
      ["at", { at: FIXED_NOW }],
      ["compiled", { compiled_to_kn: "KN-0001" }],
      ["compiled-null", { compiled_to_kn: null }],
    ]) {
      const setup = setupObservationHost(context, `writer-${variant}`);
      const draft = path.join(setup.artifacts, `${variant}.json`);
      writeAgentDraft(draft, overrides);
      runNode(context, OBSERVE_ADD, [draft, "--now", FIXED_NOW], {
        cwd: setup.project,
        env: observationEnv(setup.project),
        expectFailure: true,
      });
      ensure(context, listYaml(path.join(setup.project, ".kg", "observations")).length === 0, `${variant} failure wrote an observation`);
    }
  });

  testCase(context, "reject_non_json_and_kg_isolation_paths", () => {
    const setup = setupObservationHost(context, "input-safety");
    const yamlDraft = path.join(setup.artifacts, "draft.yaml");
    fs.writeFileSync(yamlDraft, "source: human_correction\nclaim: legacy agent input\n");
    runNode(context, OBSERVE_ADD, [yamlDraft, "--now", FIXED_NOW], {
      cwd: setup.project,
      env: observationEnv(setup.project),
      expectFailure: true,
    });

    const kgCaseDir = path.join(setup.artifacts, ".KG");
    fs.mkdirSync(kgCaseDir);
    const kgDraft = path.join(kgCaseDir, "draft.json");
    fs.copyFileSync(path.join(OBSERVE_FIXTURE, "agent-draft.json"), kgDraft);
    runNode(context, OBSERVE_ADD, [kgDraft, "--now", FIXED_NOW], {
      cwd: setup.project,
      env: observationEnv(setup.project),
      expectFailure: true,
    });

    const nestedRoot = path.join(context.root, "unsafe-root", ".kG", "project");
    fs.mkdirSync(path.join(nestedRoot, ".kg", "observations", "processed"), { recursive: true });
    runNode(context, OBSERVE_ADD, ["--stdin", "--now", FIXED_NOW], {
      cwd: nestedRoot,
      env: observationEnv(nestedRoot),
      input: fs.readFileSync(path.join(OBSERVE_FIXTURE, "agent-draft.json"), "utf8"),
      expectFailure: true,
    });
  });

  testCase(context, "archive_preflight_rejects_bad_kn_and_preserves_pending", () => {
    for (const [variant, kn] of [
      ["invalid-format", "KN-1"],
      ["empty", ""],
      ["multiple", "KN-0001,KN-0002"],
      ["missing", "KN-9999"],
    ]) {
      const setup = setupObservationHost(context, `archive-${variant}`);
      const pending = path.join(setup.project, ".kg", "observations", "OBS-20260730-001.yaml");
      fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), pending);
      const before = fileHash(pending);
      runNode(
        context,
        OBSERVE_ARCHIVE,
        ["--observation", "OBS-20260730-001", "--compiled-to-kn", kn],
        { cwd: setup.project, env: observationEnv(setup.project), expectFailure: true },
      );
      ensure(context, fs.existsSync(pending) && fileHash(pending) === before, `${variant} archive changed pending source`);
      ensure(
        context,
        !fs.existsSync(path.join(setup.project, ".kg", "observations", "processed", "OBS-20260730-001.yaml")),
        `${variant} archive created processed output`,
      );
    }

    const invalid = setupObservationHost(context, "archive-invalid-knowledge", { includeKnowledge: false });
    const invalidPending = path.join(invalid.project, ".kg", "observations", "OBS-20260730-001.yaml");
    fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), invalidPending);
    fs.writeFileSync(path.join(invalid.project, "knowledge", "KN-0001-invalid.md"), "---\nid: KN-0001\n---\ninvalid\n");
    const invalidHash = fileHash(invalidPending);
    runNode(
      context,
      OBSERVE_ARCHIVE,
      ["--observation", "OBS-20260730-001", "--compiled-to-kn", "KN-0001"],
      { cwd: invalid.project, env: observationEnv(invalid.project), expectFailure: true },
    );
    ensure(context, fileHash(invalidPending) === invalidHash, "invalid knowledge archive changed pending source");
  });

  testCase(context, "archive_rejects_invalid_result_selection_and_preserves_pending", () => {
    for (const [variant, args, expectedError] of [
      [
        "both-results",
        ["--observation", "OBS-20260730-001", "--compiled-to-kn", "KN-0001", "--verdict", "no_change"],
        "mutually exclusive",
      ],
      [
        "missing-result",
        ["--observation", "OBS-20260730-001"],
        "exactly one of --compiled-to-kn or --verdict is required",
      ],
      [
        "unknown-verdict",
        ["--observation", "OBS-20260730-001", "--verdict", "not_in_routing"],
        "invalid no-knowledge verdict",
      ],
      [
        "kn-category-as-verdict",
        ["--observation", "OBS-20260730-001", "--verdict", "project_knowledge"],
        "invalid no-knowledge verdict",
      ],
    ]) {
      const setup = setupObservationHost(context, `archive-mode-${variant}`);
      const pending = path.join(setup.project, ".kg", "observations", "OBS-20260730-001.yaml");
      const processed = path.join(setup.project, ".kg", "observations", "processed", "OBS-20260730-001.yaml");
      fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), pending);
      const before = fileHash(pending);
      const rejected = runNode(context, OBSERVE_ARCHIVE, args, {
        cwd: setup.project,
        env: observationEnv(setup.project),
        expectFailure: true,
      });
      ensure(context, rejected.stderr.includes(expectedError), `${variant} failure reason was not reported`);
      ensure(context, fs.existsSync(pending) && fileHash(pending) === before, `${variant} changed pending source`);
      ensure(context, !fs.existsSync(processed), `${variant} created processed output`);
    }
  });

  testCase(context, "archive_rejects_existing_processed_target", () => {
    const setup = setupObservationHost(context, "archive-existing");
    const pending = path.join(setup.project, ".kg", "observations", "OBS-20260730-001.yaml");
    const processed = path.join(setup.project, ".kg", "observations", "processed", "OBS-20260730-001.yaml");
    fs.copyFileSync(path.join(OBSERVE_FIXTURE, "v1-observation.yaml"), pending);
    fs.writeFileSync(processed, "sentinel\n");
    const pendingHash = fileHash(pending);
    runNode(
      context,
      OBSERVE_ARCHIVE,
      ["--observation", "OBS-20260730-001", "--compiled-to-kn", "KN-0001"],
      { cwd: setup.project, env: observationEnv(setup.project), expectFailure: true },
    );
    ensure(context, fileHash(pending) === pendingHash, "existing destination failure changed pending source");
    ensure(context, fs.readFileSync(processed, "utf8") === "sentinel\n", "existing processed target was overwritten");
  });
}

function parseArgs(argv) {
  const selected = [];
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg !== "--part") throw new Error(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--part needs a part number or name");
    selected.push(value);
    index += 1;
  }
  return { list, selected };
}

function resolveParts(values) {
  if (values.length === 0) return PARTS;
  const out = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    const part = PARTS.find(
      (candidate) =>
        String(candidate.number) === normalized ||
        `part${candidate.number}` === normalized.replace(/\s+/g, "") ||
        candidate.name === value,
    );
    if (!part) throw new Error(`unknown part: ${value}`);
    if (!out.includes(part)) out.push(part);
  }
  return out.sort((a, b) => a.number - b.number);
}

function printParts() {
  for (const part of PARTS) console.log(`Part ${part.number}\t${part.name}\t${part.status}`);
}

function main() {
  let args, selected;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.list) {
      if (args.selected.length) throw new Error("--list cannot be combined with --part");
      printParts();
      return;
    }
    selected = resolveParts(args.selected);
  } catch (error) {
    console.error(`test-v2: ${error.message}`);
    process.exit(1);
  }

  const roots = [];
  try {
    for (const part of selected) {
      if (part.status === "pending") {
        console.log(`pending Part ${part.number} ${part.name}`);
        continue;
      }
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `kg-v2-part-${part.number}-`));
      roots.push(root);
      const context = {
        part: part.number,
        partName: part.name,
        caseName: "setup",
        command: "filesystem assertion",
        root,
      };
      part.run(context);
      console.log(`PASS Part ${part.number} ${part.name}`);
    }
  } catch (error) {
    const failure = error instanceof CaseFailure
      ? error
      : new CaseFailure(
          {
            part: "unknown",
            partName: "unknown",
            caseName: "unknown",
            command: "internal test runner",
            root: roots.at(-1) ?? "(none)",
          },
          error.stack ?? error.message,
        );
    console.error("test-v2 FAILED");
    console.error(`part: Part ${failure.context.part} ${failure.context.partName}`);
    console.error(`case: ${failure.context.caseName}`);
    console.error(`command: ${failure.command}`);
    console.error(`exit_code: ${failure.exitCode}`);
    console.error(`artifact_root: ${failure.context.root}`);
    console.error(`reason: ${failure.message}`);
    if (failure.stdout.trim()) console.error(`stdout:\n${failure.stdout.trim()}`);
    if (failure.stderr.trim()) console.error(`stderr:\n${failure.stderr.trim()}`);
    process.exit(1);
  }

  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  console.log(`test-v2: ${selected.filter((part) => part.status === "implemented").length} implemented part(s) passed`);
}

main();
