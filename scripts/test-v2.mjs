// Black-box deterministic runner for the seven M2 walking-skeleton parts.
// R2.5 closes M2 with all seven walking-skeleton parts implemented.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as kyaml from "./lib/kyaml.mjs";
import * as protocol from "./lib/protocol.mjs";
import * as harness from "./lib/harness.mjs";
import * as compilePlan from "./lib/compile-plan.mjs";
import * as inverseMap from "./lib/inverse-map.mjs";
import * as proposal from "./lib/proposal.mjs";
import * as host from "./lib/host.mjs";
import {
  relativeProductPath as normalizeRunnerProjectProduct,
  resolveArtifactProduct as normalizeRunnerArtifactProduct,
  runnerEnvelopeConformanceProfile,
  validateRunnerResponse,
} from "./eval-bootstrap.mjs";
import { computeMigrationPlanId } from "../skills/kg-init/scripts/migration-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = "2026-07-31T00:00:00Z";
const MIGRATION_NOW = "2026-07-31T00:00:00.000Z";
const PARTS = [
  { number: 1, name: "migration_protocol_v2_preserves_and_recovers", status: "implemented", run: runPart1 },
  { number: 2, name: "docs_bootstrap_renders_architecture_draft", status: "implemented", run: runPart2 },
  { number: 3, name: "observe_json_preserves_v1_contract", status: "implemented", run: runPart3 },
  { number: 4, name: "compile_links_observation_kn_and_managed_block", status: "implemented", run: runPart4 },
  { number: 5, name: "kickoff_indexes_compiled_kn_and_carrier", status: "implemented", run: runPart5 },
  { number: 6, name: "spec_archives_compiled_context_transcript", status: "implemented", run: runPart6 },
  { number: 7, name: "scan_reports_one_missing_source_ref", status: "implemented", run: runPart7 },
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
const COMPILE_CONTEXT = path.join(ROOT, "skills", "kg-compile", "scripts", "compile.mjs");
const COMPILE_APPLY = path.join(ROOT, "skills", "kg-compile", "scripts", "apply-compile-plan.mjs");
const EVAL_COMPILE = path.join(ROOT, "scripts", "eval-compile.mjs");
const EVAL_KICKOFF = path.join(ROOT, "scripts", "eval-kickoff.mjs");
const EVAL_SPEC = path.join(ROOT, "scripts", "eval-spec.mjs");
const GATHER_KICKOFF_CONTEXT = path.join(ROOT, "skills", "kg-kickoff", "scripts", "gather-context.mjs");
const RECORD_KICKOFF_TURN = path.join(ROOT, "skills", "kg-kickoff", "scripts", "record-turn.mjs");
const SPEC_PRODUCE = path.join(ROOT, "skills", "kg-spec", "scripts", "produce-spec.mjs");
const STALENESS_CHECK = path.join(ROOT, "skills", "kg-scan", "scripts", "check-staleness.mjs");
const HEALTH_CHECK = path.join(ROOT, "skills", "kg-scan", "scripts", "health-check.mjs");
const INIT_INSTALL = path.join(ROOT, "skills", "kg-init", "scripts", "install.mjs");
const FIXTURE_LINT = path.join(ROOT, "scripts", "lint-fixtures.mjs");
const MOCK_BOOTSTRAP_RUNNER = path.join(ROOT, "scripts", "fixtures", "m2", "mock-bootstrap-runner.mjs");
const MOCK_BOOTSTRAP_V2_RUNNER = path.join(ROOT, "scripts", "fixtures", "m3", "mock-bootstrap-runner.mjs");
const BOOTSTRAP_V2_EVAL_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m3", "bootstrap-all-types", "fixture.json");
const BOOTSTRAP_PROPOSAL_EVAL_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m3", "bootstrap-proposal", "fixture.json");
const REAL_BOOTSTRAP_RUNNER_ENVELOPE = path.join(ROOT, "scripts", "fixtures", "m3", "real-bootstrap-runner-envelope.json");
const MOCK_COMPILE_RUNNER = path.join(ROOT, "scripts", "fixtures", "m2", "mock-compile-runner.mjs");
const MOCK_KICKOFF_RUNNER = path.join(ROOT, "scripts", "fixtures", "m2", "mock-kickoff-runner.mjs");
const BOOTSTRAP_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "bootstrap");
const OBSERVE_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "observe");
const MIGRATION_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "migration-v1");
const MIGRATION_RECOVERY_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "migration-recovery");
const MIGRATION_CHECKPOINT_DRIVER = path.join(ROOT, "scripts", "kill-migration-at-checkpoint.mjs");
const COMPILE_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "compile-fixture");
const KICKOFF_FIXTURES = [
  path.join(ROOT, "scripts", "fixtures", "m1", "kickoff.fixture.yaml"),
  path.join(ROOT, "scripts", "fixtures", "m1", "kickoff-no-conflict.fixture.yaml"),
  path.join(ROOT, "scripts", "fixtures", "m2", "kickoff-03.fixture.yaml"),
];
const KICKOFF_COMPILED_PROJECT = path.join(ROOT, "scripts", "fixtures", "m2", "kickoff-03-project");
const SPEC_FIXTURES = [
  path.join(ROOT, "scripts", "fixtures", "m2", "spec-01-conflict", "fixture.yaml"),
  path.join(ROOT, "scripts", "fixtures", "m2", "spec-02-no-conflict", "fixture.yaml"),
  path.join(ROOT, "scripts", "fixtures", "m2", "spec-03-compiled", "fixture.yaml"),
];
const KG_SKILLS = ["kg-init", "kg-observe", "kg-compile", "kg-scan", "kg-kickoff", "kg-spec", "kg-docs"];
const FINDING_FIELDS_FOR_TEST = {
  observed_fact: true,
  inference: true,
  conflict: true,
  unknown: true,
};

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

function runMigrationAction(context, setup, args, options = {}) {
  const result = runNode(
    context,
    MIGRATION_EXECUTE,
    ["--root", setup.project, ...args],
    { cwd: setup.project, expectFailure: options.expectFailure === true },
  );
  const stream = result.stdout.trim() ? result.stdout : result.stderr;
  return { process: result, value: JSON.parse(stream) };
}

function addInvalidQueueItems(setup) {
  fs.copyFileSync(
    path.join(MIGRATION_RECOVERY_FIXTURE, "invalid-format.yaml"),
    path.join(setup.project, ".kg", "queue", "Q-20260731-002.yaml"),
  );
  fs.copyFileSync(
    path.join(MIGRATION_RECOVERY_FIXTURE, "unmappable-category.yaml"),
    path.join(setup.project, ".kg", "queue", "Q-20260731-003.yaml"),
  );
}

function resolutionForPlan(plan) {
  return {
    kind: "kg.migration_resolution",
    version: 1,
    plan_id: plan.id,
    items: plan.quarantine.map((item, index) => ({
      source_path: item.source_path,
      source_sha256: item.source_sha256,
      disposition: index === 0 ? "retain_quarantined" : "convert",
      ...(index === 0
        ? {}
        : {
            record: {
              kind: "proposal",
              category: "project_contract",
              claim: "Converted during migration recovery testing.",
              evidence: [{ type: "quote", ref: "migration fixture" }],
              options: ["accept", "reject"],
              recommendation: "Review the converted record.",
              entry: null,
              source_observations: [],
            },
          }),
    })),
  };
}

function replaceStringDeep(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replaceStringDeep(item, from, to));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStringDeep(item, from, to)]));
  }
  return value;
}

function resealPlan(plan) {
  const oldId = plan.id;
  const newId = computeMigrationPlanId(plan);
  const replaced = replaceStringDeep(plan, oldId, newId);
  replaced.id = newId;
  return replaced;
}

function migrationScaffolding(root) {
  const found = [];
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.startsWith(".kg-migration-")) found.push(rel);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(current, entry.name), rel);
    }
  }
  walk(root, "");
  return found.sort();
}

function runCheckpointDriver(context, setup, checkpoint, childArgs, mode = "kill") {
  const ready = path.join(setup.artifacts, `${checkpoint}-${mode}.ready`);
  const release = path.join(setup.artifacts, `${checkpoint}-${mode}.release`);
  const driven = runNode(
    context,
    MIGRATION_CHECKPOINT_DRIVER,
    [
      "--checkpoint",
      checkpoint,
      "--mode",
      mode,
      "--ready",
      ready,
      "--release",
      release,
      "--cwd",
      setup.project,
      "--",
      MIGRATION_EXECUTE,
      "--root",
      setup.project,
      ...childArgs,
    ],
    { cwd: setup.project },
  );
  return JSON.parse(driven.stdout);
}

function detectHost(context, project) {
  const result = runNode(context, MIGRATION_DETECT, ["--root", project], { cwd: project });
  return JSON.parse(result.stdout);
}

function installHost(context, project, options = {}) {
  return runNode(
    context,
    INIT_INSTALL,
    [project, "--copy", "--docs-profile", options.docsProfile ?? "none"],
    { cwd: ROOT, expectFailure: options.expectFailure === true },
  );
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
  testCase(context, "detects_greenfield_without_mutation", () => {
    const project = path.join(context.root, "detect-greenfield");
    fs.mkdirSync(project, { recursive: true });
    const before = treeHash(project);
    const detected = detectHost(context, project);
    ensure(context, detected.kind === "kg.migration_detection" && detected.version === 2, "detection shape version mismatch");
    ensure(context, detected.classification === "greenfield", "empty host was not classified greenfield");
    ensure(context, detected.spec_scenario === "fresh" && detected.condition === "healthy", "greenfield scenario mismatch");
    ensure(context, JSON.stringify(detected.allowed_actions) === JSON.stringify(["install"]), "greenfield actions mismatch");
    ensure(context, detected.requires_human === false && detected.bootstrap_recommended === false, "greenfield flags mismatch");
    ensure(context, treeHash(project) === before, "greenfield detection mutated the host");
  });

  testCase(context, "detects_non_kg_host_and_recommends_bootstrap", () => {
    const project = path.join(context.root, "detect-non-kg");
    fs.mkdirSync(project, { recursive: true });
    writeJson(path.join(project, "package.json"), { name: "non-kg-host" });
    fs.mkdirSync(path.join(project, "src"));
    fs.writeFileSync(path.join(project, "src", "index.mjs"), "export const ready = true;\n");
    const before = treeHash(project);
    const detected = detectHost(context, project);
    ensure(context, detected.classification === "non_kg_host", "project host was not classified non_kg_host");
    ensure(context, detected.spec_scenario === "brownfield", "non-kg scenario mismatch");
    ensure(context, detected.bootstrap_recommended === true, "source host did not recommend bootstrap");
    ensure(context, JSON.stringify(detected.allowed_actions) === JSON.stringify(["install"]), "non-kg actions mismatch");
    ensure(context, treeHash(project) === before, "non-kg detection mutated the host");
  });

  testCase(context, "detects_healthy_v1", () => {
    const setup = setupMigrationCase(context, "detect-v1");
    const before = treeHash(setup.project);
    const detected = detectHost(context, setup.project);
    ensure(context, detected.classification === "v1" && detected.condition === "healthy", "healthy v1 was not detected");
    ensure(context, JSON.stringify(detected.allowed_actions) === JSON.stringify(["migrate"]), "v1 actions mismatch");
    ensure(context, detected.problems.length === 0, "healthy v1 reported problems");
    ensure(context, treeHash(setup.project) === before, "v1 detection mutated the host");
  });

  testCase(context, "detects_healthy_v2_as_noop", () => {
    const project = path.join(context.root, "detect-v2");
    fs.mkdirSync(project, { recursive: true });
    installHost(context, project, { docsProfile: "lean" });
    const before = treeHash(project);
    const detected = detectHost(context, project);
    ensure(context, detected.classification === "v2" && detected.condition === "healthy", "healthy v2 was not detected");
    ensure(context, JSON.stringify(detected.allowed_actions) === JSON.stringify(["verify"]), "v2 actions mismatch");
    installHost(context, project, { docsProfile: "lean" });
    ensure(context, treeHash(project) === before, "healthy v2 installer rerun changed the host");
  });

  testCase(context, "detects_partial_broken_with_stable_problem_codes", () => {
    const setup = setupMigrationCase(context, "detect-partial");
    for (const name of ["kg-compile", "kg-scan"]) {
      fs.rmSync(path.join(setup.project, ".agents", "skills", name), { recursive: true, force: true });
    }
    const before = treeHash(setup.project);
    const first = detectHost(context, setup.project);
    const second = detectHost(context, setup.project);
    ensure(context, first.classification === "partial_broken" && first.condition === "partial", "incomplete v1 was not partial");
    ensure(context, first.requires_human === false, "automatic incomplete v1 requested human review");
    ensure(context, JSON.stringify(first.allowed_actions) === JSON.stringify(["repair"]), "automatic partial actions mismatch");
    ensure(
      context,
      JSON.stringify(first.problems.map((problem) => problem.code)) === JSON.stringify(["V1_SKILL_MISSING", "V1_SKILL_MISSING"]),
      "incomplete v1 problem codes are unstable",
    );
    ensure(context, first.problems.every((problem) => problem.recoverability === "automatic"), "missing skills are not automatic");
    ensure(context, JSON.stringify(first.problems) === JSON.stringify(second.problems), "problem list changed across identical reads");
    ensure(context, treeHash(setup.project) === before, "partial detection mutated the host");
  });

  testCase(context, "classification_is_canonical_path_invariant", () => {
    const project = path.join(context.root, "canonical-host");
    const alias = path.join(context.root, "canonical-host-alias");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "main.ts"), "export const value = 1;\n");
    fs.symlinkSync(project, alias, "dir");
    const direct = detectHost(context, project);
    const throughAlias = detectHost(context, alias);
    for (const field of ["classification", "spec_scenario", "condition", "signals", "problems", "allowed_actions", "requires_human", "bootstrap_recommended"]) {
      ensure(context, JSON.stringify(direct[field]) === JSON.stringify(throughAlias[field]), `canonical alias changed ${field}`);
    }
    ensure(context, direct.root.canonical === throughAlias.root.canonical, "canonical roots differ through alias");
    ensure(context, direct.root.declared !== throughAlias.root.declared, "declared roots did not retain audit spelling");
  });

  testCase(context, "greenfield_install_is_lazy_and_idempotent", () => {
    const project = path.join(context.root, "lazy-greenfield");
    fs.mkdirSync(project, { recursive: true });
    installHost(context, project, { docsProfile: "standard" });
    for (const relative of ["docs/README.md", "docs/architecture", "docs/decisions", "docs/rfcs", "docs/standards"]) {
      ensure(context, fs.existsSync(path.join(project, relative)), `lazy standard profile missing ${relative}`);
    }
    for (const relative of [
      "docs/architecture/overview.md",
      "docs/decisions/0000-template.md",
      "docs/rfcs/0000-template.md",
      "docs/glossary.md",
      "docs/development.md",
    ]) {
      ensure(context, !fs.existsSync(path.join(project, relative)), `init eagerly created ${relative}`);
    }
    const config = kyaml.parse(fs.readFileSync(path.join(project, ".kg", "config.yaml"), "utf8"));
    ensure(context, config.kind === "kg.config" && config.version === 2, "fresh config is not v2");
    const before = treeHash(project);
    installHost(context, project, { docsProfile: "standard" });
    ensure(context, treeHash(project) === before, "second lazy install changed the host");
  });

  testCase(context, "non_kg_install_preserves_existing_docs_and_agents", () => {
    const project = path.join(context.root, "preserve-non-kg");
    const docsText = "# Human documentation map\n\nKeep these bytes.\n";
    const agentsText = "# Human project instructions\n\nKeep this preface byte for byte.\n";
    fs.mkdirSync(path.join(project, "docs"), { recursive: true });
    fs.writeFileSync(path.join(project, "docs", "README.md"), docsText);
    fs.writeFileSync(path.join(project, "AGENTS.md"), agentsText);
    writeJson(path.join(project, "package.json"), { name: "preservation-host" });
    const first = detectHost(context, project);
    ensure(context, first.classification === "non_kg_host", "preservation fixture was not non-kg");
    installHost(context, project, { docsProfile: "standard" });
    ensure(context, fs.readFileSync(path.join(project, "docs", "README.md"), "utf8") === docsText, "existing docs README changed");
    const installedAgents = fs.readFileSync(path.join(project, "AGENTS.md"), "utf8");
    ensure(context, installedAgents.startsWith(agentsText), "existing AGENTS bytes changed");
    ensure(context, countHeading(installedAgents, "硬规则") === 1, "v2 hard rule section missing");
    ensure(context, countHeading(installedAgents, "Commands") === 1, "v2 Commands section missing");
    ensure(context, countHeading(installedAgents, "使用 kg") === 1, "v2 usage section missing");
    ensure(context, detectHost(context, project).classification === "v2", "non-kg install did not converge to v2");
  });

  testCase(context, "greenfield_install_preflight_failure_is_zero_write", () => {
    const project = path.join(context.root, "install-preflight");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "harness"), "occupied managed path\n");
    const before = treeHash(project);
    installHost(context, project, { docsProfile: "standard", expectFailure: true });
    ensure(context, treeHash(project) === before, "install preflight failure left partial writes");
    ensure(context, detectHost(context, project).classification === "non_kg_host", "preflight failure changed classification");
  });

  testCase(context, "v1_missing_two_legacy_skills_routes_to_automatic_repair_plan", () => {
    const setup = setupMigrationCase(context, "v1-two-skills");
    for (const name of ["kg-compile", "kg-scan"]) {
      fs.rmSync(path.join(setup.project, ".agents", "skills", name), { recursive: true, force: true });
    }
    const before = treeHash(setup.project);
    const result = installHost(context, setup.project, { expectFailure: true });
    const machine = JSON.parse(result.stdout);
    ensure(context, result.status === 2, "automatic repair route did not use the classification exit");
    ensure(context, machine.classification === "partial_broken", "repair result lost partial classification");
    ensure(context, machine.next_action === "generate_repair_plan", "automatic partial did not route to repair plan");
    ensure(context, machine.problems.every((problem) => problem.recoverability === "automatic"), "repair route became human");
    ensure(context, treeHash(setup.project) === before, "repair-plan route mutated the v1 host");
  });

  testCase(context, "phase0_is_read_only_and_plan_is_outside_host", () => {
    const setup = setupMigrationCase(context, "phase0-read-only");
    const before = treeHash(setup.project);
    const first = generateMigrationPlan(context, setup);
    ensure(context, treeHash(setup.project) === before, "Phase 0 changed the host tree");
    ensure(context, host.isOutside(setup.project, setup.plan), "Phase 0 plan was written inside the host");
    const secondPlan = path.join(setup.artifacts, "migration-plan-second.json");
    const second = JSON.parse(runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", setup.project, "--output", secondPlan, "--now", "2026-08-01T00:00:00.000Z"],
      { cwd: setup.project },
    ).stdout);
    ensure(context, first.id === second.id, "generated_at changed the canonical action identity");
    ensure(context, treeHash(setup.project) === before, "repeated Phase 0 changed the host tree");
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", setup.project, "--output", path.join(setup.project, "plan.json"), "--now", MIGRATION_NOW],
      { cwd: setup.project, expectFailure: true },
    );
    ensure(context, treeHash(setup.project) === before, "inside-host plan rejection changed the host");
  });

  testCase(context, "migration_v1_preserves_all_assets", () => {
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
    ensure(context, plan.kind === "kg.migration_plan" && plan.version === 2, "migration plan kind or version mismatch");
    ensure(context, plan.source.classification === "v1", "migration plan did not bind the v1 detection");
    ensure(context, plan.context.queue_items.length === 1, "compatible queue item was not represented in the plan");
    ensure(
      context,
      plan.context.queue_items[0].strategy === "preserve_compatible_v1_record",
      "compatible queue item preservation strategy mismatch",
    );
    for (const field of ["operations", "preserved", "quarantine", "before_images", "lazy_absent_files"]) {
      ensure(context, Array.isArray(plan[field]), `migration plan is missing ${field}`);
    }
    ensure(context, Array.isArray(plan.recovery.checkpoints), "migration plan is missing recovery checkpoints");
    ensure(context, Array.isArray(plan.rollback.operations), "migration plan is missing rollback operations");
    ensure(context, typeof plan.skills_source.digest === "string", "migration plan is missing the skill source digest");
    const operationPaths = plan.operations.map((operation) => operation.path);
    ensure(context, new Set(operationPaths).size === operationPaths.length, "migration plan contains duplicate paths");
    for (const required of [".kg/config.v1.bak", ".kg/config.yaml", "AGENTS.md"]) {
      ensure(context, operationPaths.includes(required), `migration plan is missing ${required}`);
    }
    for (const operation of plan.operations) {
      ensure(context, typeof operation.action === "string", `plan action missing for ${operation.path}`);
      ensure(context, typeof operation.preserve === "string", `plan preservation strategy missing for ${operation.path}`);
      ensure(context, operation.ownership === "migration_plan", `plan ownership missing for ${operation.path}`);
      ensure(context, operation.recovery?.strategy, `plan recovery strategy missing for ${operation.path}`);
      ensure(context, operation.rollback?.strategy, `plan rollback strategy missing for ${operation.path}`);
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
    fs.rmSync(path.join(setup.project, "knowledge", "KN-0001-migration-preservation.md"));
    fs.copyFileSync(
      path.join(setup.project, ".kg", "config.yaml"),
      path.join(setup.project, ".kg", "config.v1.bak"),
    );
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
      !plan.operations.some((operation) => operation.path === ".kg/config.v1.bak"),
      "byte-identical recovery backup was scheduled for replacement",
    );
    ensure(context, plan.context.agents_injected_commands === false, "human Commands section was not detected");
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

  testCase(context, "queue_items_convert_or_enter_quarantine", () => {
    const setup = setupMigrationCase(context, "quarantine-routing");
    addInvalidQueueItems(setup);
    const original = Object.fromEntries(
      ["Q-20260731-002.yaml", "Q-20260731-003.yaml"].map((name) => [
        name,
        fs.readFileSync(path.join(setup.project, ".kg", "queue", name)),
      ]),
    );
    const plan = generateMigrationPlan(context, setup);
    ensure(context, plan.quarantine.length === 2, "plan did not route every unmappable queue item to quarantine");
    ensure(
      context,
      JSON.stringify(plan.quarantine.map((item) => item.reason).sort()) ===
        JSON.stringify(["invalid_format", "unmappable_category"]),
      "quarantine reasons are incomplete",
    );
    const blocked = runMigrationAction(context, setup, ["--execute", "--plan", setup.plan], { expectFailure: true });
    ensure(context, blocked.process.status === 2, "quarantine execution did not use exit 2");
    ensure(context, blocked.value.status === "blocked_on_quarantine", "quarantine execution did not block");
    ensure(context, blocked.value.requires_human === true, "quarantine execution did not require a human");
    for (const item of plan.quarantine) {
      const name = path.posix.basename(item.source_path);
      ensure(context, !fs.existsSync(path.join(setup.project, item.source_path)), `quarantine source remains: ${item.source_path}`);
      ensure(
        context,
        fs.readFileSync(path.join(setup.project, item.quarantine_path)).equals(original[name]),
        `quarantine did not preserve original bytes: ${item.source_path}`,
      );
    }
    ensure(context, !fs.existsSync(path.join(setup.project, ".kg", "config.v1.bak")), "blocked quarantine crossed into config writes");
  });

  testCase(context, "quarantine_requires_complete_human_resolution", () => {
    const setup = setupMigrationCase(context, "quarantine-resolution");
    addInvalidQueueItems(setup);
    const plan = generateMigrationPlan(context, setup);
    runMigrationAction(context, setup, ["--execute", "--plan", setup.plan], { expectFailure: true });
    const valid = resolutionForPlan(plan);
    const invalidVariants = [
      { name: "incomplete", value: { ...valid, items: valid.items.slice(0, 1) } },
      { name: "duplicate", value: { ...valid, items: [valid.items[0], valid.items[0]] } },
      { name: "hash", value: { ...valid, items: valid.items.map((item, index) => index ? item : { ...item, source_sha256: "0".repeat(64) }) } },
      { name: "disposition", value: { ...valid, items: valid.items.map((item, index) => index ? item : { ...item, disposition: "discard" }) } },
      { name: "plan", value: { ...valid, plan_id: "MIG-000000000000000000000000" } },
      { name: "unknown-field", value: { ...valid, unexpected: true } },
    ];
    for (const variant of invalidVariants) {
      const file = path.join(setup.artifacts, `resolution-${variant.name}.json`);
      writeJson(file, variant.value);
      const before = treeHash(setup.project);
      runMigrationAction(context, setup, ["--resolve", file, "--plan", setup.plan], { expectFailure: true });
      ensure(context, treeHash(setup.project) === before, `invalid ${variant.name} resolution changed the host`);
    }
    const resolutionFile = path.join(setup.artifacts, "resolution-valid.json");
    writeJson(resolutionFile, valid);
    const completed = runMigrationAction(context, setup, ["--resolve", resolutionFile, "--plan", setup.plan]);
    ensure(context, completed.value.status === "complete", "complete resolution did not finish migration");
    ensure(context, detectHost(context, setup.project).classification === "v2", "resolved quarantine did not converge to v2");
    const stable = treeHash(setup.project);
    const repeated = runMigrationAction(context, setup, ["--resolve", resolutionFile, "--plan", setup.plan]);
    ensure(context, repeated.value.status === "complete", "repeated resolution did not remain complete");
    ensure(context, treeHash(setup.project) === stable, "repeated resolution changed the terminal tree");
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

  testCase(context, "rejects_incomplete_skill_source_pre_mutation", () => {
    const setup = setupMigrationCase(context, "bad-source");
    const before = treeHash(setup.project);
    const missing = {
      "kg-init": "SKILL.md",
      "kg-observe": "scripts/lib",
      "kg-compile": "protocol",
      "kg-scan": "scripts/_lib.mjs",
      "kg-kickoff": "scripts/gather-context.mjs",
      "kg-spec": "scripts/produce-spec.mjs",
      "kg-docs": "scripts/inventory.mjs",
    };
    for (const [name, relative] of Object.entries(missing)) {
      const badSource = path.join(setup.caseRoot, `bad-skills-${name}`);
      fs.cpSync(path.join(ROOT, "skills"), badSource, { recursive: true });
      fs.rmSync(path.join(badSource, name, ...relative.split("/")), { recursive: true, force: true });
      runNode(
        context,
        MIGRATION_EXECUTE,
        ["--root", setup.project, "--output", path.join(setup.artifacts, `${name}.json`), "--skills-source", badSource, "--now", MIGRATION_NOW],
        { cwd: setup.project, expectFailure: true },
      );
      ensure(context, treeHash(setup.project) === before, `incomplete ${name} source changed the host`);
    }
    ensure(context, !fs.existsSync(path.join(setup.project, ".kg", "config.v1.bak")), "incomplete source failure created a backup");
  });

  testCase(context, "plan_owns_and_cleans_orphan_scaffolding", () => {
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
    const claimed = plan.operations
      .filter((operation) => operation.action === "remove_internal_scaffolding")
      .map((operation) => operation.path)
      .sort();
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

  testCase(context, "sealed_internal_plan_recovers_lost_external_plan", () => {
    const setup = setupMigrationCase(context, "sealed-plan-recovery");
    const plan = generateMigrationPlan(context, setup);
    const killed = runCheckpointDriver(context, setup, "after_sealed_plan", ["--execute", "--plan", setup.plan]);
    ensure(context, killed.signal === "SIGKILL", "sealed-plan checkpoint did not receive SIGKILL");
    fs.rmSync(setup.plan, { force: true });
    const recovered = runMigrationAction(context, setup, ["--execute"]);
    ensure(context, recovered.value.plan_id === plan.id, "recovery did not use the sealed plan id");
    ensure(context, recovered.value.status === "complete", "sealed internal plan did not complete");
    ensure(context, detectHost(context, setup.project).classification === "v2", "sealed-plan recovery did not reach v2");

    const repaired = setupMigrationCase(context, "sealed-plan-repaired-from-external");
    const repairedPlan = generateMigrationPlan(context, repaired);
    runCheckpointDriver(context, repaired, "after_sealed_plan", ["--execute", "--plan", repaired.plan]);
    fs.writeFileSync(
      path.join(repaired.project, ".kg", "migration", "plans", `${repairedPlan.id}.json`),
      "{corrupt sealed plan\n",
    );
    const repairedResult = runMigrationAction(context, repaired, ["--execute", "--plan", repaired.plan]);
    ensure(context, repairedResult.value.status === "complete", "valid external plan did not repair the damaged internal copy");
  });

  testCase(context, "rollback_restores_verified_v1_before_images", () => {
    const setup = setupMigrationCase(context, "rollback-positive");
    const original = treeHash(setup.project);
    const plan = generateMigrationPlan(context, setup);
    executeMigration(context, setup);
    const rolledBack = runMigrationAction(context, setup, ["--rollback", "--plan", setup.plan]);
    ensure(context, rolledBack.value.status === "clean_v1", "rollback did not report clean v1");
    ensure(context, treeHash(setup.project) === original, "rollback did not restore the original v1 tree");
    const stable = treeHash(setup.project);
    const repeated = runMigrationAction(context, setup, ["--rollback", "--plan", setup.plan]);
    ensure(context, repeated.value.restored.length === 0 && repeated.value.deleted.length === 0, "rollback rerun was not idempotent");
    ensure(context, treeHash(setup.project) === stable, "rollback rerun changed clean v1");

    const corrupt = setupMigrationCase(context, "rollback-corrupt-image");
    const corruptPlan = generateMigrationPlan(context, corrupt);
    executeMigration(context, corrupt);
    const agentsImage = corruptPlan.before_images.find((item) => item.target_path === "AGENTS.md");
    fs.writeFileSync(path.join(corrupt.project, agentsImage.image_path), "corrupt before image\n");
    const beforeFailure = treeHash(corrupt.project);
    const rejected = runMigrationAction(context, corrupt, ["--rollback", "--plan", corrupt.plan], { expectFailure: true });
    ensure(context, rejected.value.code === "corrupt_before_image", "corrupt before image did not enter manual recovery");
    ensure(context, treeHash(corrupt.project) === beforeFailure, "corrupt before image failure changed the host");

    const unowned = setupMigrationCase(context, "rollback-unowned-created-directory-content");
    generateMigrationPlan(context, unowned);
    executeMigration(context, unowned);
    fs.writeFileSync(path.join(unowned.project, "docs", "specs", "human.md"), "human content\n");
    const unownedTree = treeHash(unowned.project);
    const unownedRejected = runMigrationAction(
      context,
      unowned,
      ["--rollback", "--plan", unowned.plan],
      { expectFailure: true },
    );
    ensure(context, unownedRejected.value.code === "rollback_created_directory_not_empty", "rollback accepted unowned content");
    ensure(context, treeHash(unowned.project) === unownedTree, "rollback removed content before full preflight");
    ensure(context, plan.rollback.operations.length === plan.operations.length + plan.quarantine.length, "rollback manifest is not closed");
  });

  testCase(context, "rejects_preserved_operation_ownership_overlap", () => {
    const setup = setupMigrationCase(context, "ownership-overlap");
    const plan = generateMigrationPlan(context, setup);
    const config = plan.operations.find((operation) => operation.path === ".kg/config.yaml");
    plan.preserved.push({
      path: config.path,
      fingerprint: config.before,
      strategy: "forged_overlap",
    });
    const forged = resealPlan(plan);
    writeJson(setup.plan, forged);
    const before = treeHash(setup.project);
    const rejected = runMigrationAction(context, setup, ["--execute", "--plan", setup.plan], { expectFailure: true });
    ensure(context, rejected.value.message.includes("overlaps"), "ownership overlap was not identified");
    ensure(context, treeHash(setup.project) === before, "ownership overlap rejection changed the host");
  });

  testCase(context, "rejects_drift_unknown_skills_and_corrupt_backups", () => {
    const drift = setupMigrationCase(context, "named-target-drift");
    generateMigrationPlan(context, drift);
    fs.appendFileSync(path.join(drift.project, "AGENTS.md"), "Human edit after planning.\n");
    const driftTree = treeHash(drift.project);
    const drifted = runMigrationAction(context, drift, ["--execute", "--plan", drift.plan], { expectFailure: true });
    ensure(
      context,
      ["preserved_drift", "target_drifted", "migration_failed"].includes(drifted.value.code) &&
        /drift|changed/i.test(drifted.value.message),
      "target drift was not rejected",
    );
    ensure(context, treeHash(drift.project) === driftTree, "target drift rejection changed the host");

    const unknown = setupMigrationCase(context, "named-unknown-skill");
    fs.mkdirSync(path.join(unknown.project, ".agents", "skills", "kg-unknown"));
    fs.writeFileSync(path.join(unknown.project, ".agents", "skills", "kg-unknown", "SKILL.md"), "unknown\n");
    const unknownTree = treeHash(unknown.project);
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", unknown.project, "--output", unknown.plan, "--now", MIGRATION_NOW],
      { cwd: unknown.project, expectFailure: true },
    );
    ensure(context, treeHash(unknown.project) === unknownTree, "unknown skill rejection changed the host");

    const backup = setupMigrationCase(context, "named-corrupt-backup");
    fs.writeFileSync(path.join(backup.project, ".kg", "config.v1.bak"), "corrupt backup\n");
    const backupTree = treeHash(backup.project);
    runNode(
      context,
      MIGRATION_EXECUTE,
      ["--root", backup.project, "--output", backup.plan, "--now", MIGRATION_NOW],
      { cwd: backup.project, expectFailure: true },
    );
    ensure(context, treeHash(backup.project) === backupTree, "corrupt backup rejection changed the host");

    const midflight = setupMigrationCase(context, "named-midflight-drift");
    generateMigrationPlan(context, midflight);
    runCheckpointDriver(context, midflight, "after_config_write", ["--execute", "--plan", midflight.plan]);
    fs.writeFileSync(path.join(midflight.project, ".kg", "config.yaml"), "human mid-migration edit\n");
    const midflightTree = treeHash(midflight.project);
    const midflightRejected = runMigrationAction(
      context,
      midflight,
      ["--execute", "--plan", midflight.plan],
      { expectFailure: true },
    );
    ensure(context, midflightRejected.value.status === "manual_recovery_required", "midflight drift did not enter manual recovery");
    ensure(context, treeHash(midflight.project) === midflightTree, "midflight drift rejection changed the host");

    const scaffolding = setupMigrationCase(context, "named-unknown-scaffolding");
    const scaffoldingPlan = generateMigrationPlan(context, scaffolding);
    runCheckpointDriver(context, scaffolding, "after_sealed_plan", ["--execute", "--plan", scaffolding.plan]);
    const unknownStage = path.join(scaffolding.project, ".agents", "skills", ".kg-migration-stage-MIG-unknown-kg-init");
    fs.mkdirSync(unknownStage);
    fs.writeFileSync(path.join(unknownStage, "sentinel.txt"), "unknown stage\n");
    const extraPlan = path.join(
      scaffolding.project,
      ".kg",
      "migration",
      "plans",
      "MIG-000000000000000000000000.json",
    );
    fs.copyFileSync(
      path.join(scaffolding.project, ".kg", "migration", "plans", `${scaffoldingPlan.id}.json`),
      extraPlan,
    );
    const scaffoldingTree = treeHash(scaffolding.project);
    const scaffoldingRejected = runMigrationAction(
      context,
      scaffolding,
      ["--execute", "--plan", scaffolding.plan],
      { expectFailure: true },
    );
    ensure(
      context,
      ["multiple_active_plans", "unknown_migration_scaffolding"].includes(scaffoldingRejected.value.code),
      "unknown active scaffolding did not enter manual recovery",
    );
    ensure(context, treeHash(scaffolding.project) === scaffoldingTree, "unknown scaffolding rejection changed the host");
  });

  testCase(context, "phase2_recomputes_outputs_and_rejects_self_consistent_lies", () => {
    const setup = setupMigrationCase(context, "phase2-self-consistent-lie");
    const original = treeHash(setup.project);
    const plan = generateMigrationPlan(context, setup);
    const agents = plan.operations.find((operation) => operation.path === "AGENTS.md");
    const plannedText = Buffer.from(agents.content_base64, "base64").toString("utf8");
    const lieText = plannedText.slice(plannedText.indexOf("## 硬规则"));
    const lieBytes = Buffer.from(lieText);
    agents.content_base64 = lieBytes.toString("base64");
    agents.after = {
      type: "file",
      size: lieBytes.length,
      sha256: crypto.createHash("sha256").update(lieBytes).digest("hex"),
    };
    const rollback = plan.rollback.operations.find((operation) => operation.path === "AGENTS.md");
    rollback.expected_current = agents.after;
    const forged = resealPlan(plan);
    writeJson(setup.plan, forged);
    const rejected = runMigrationAction(context, setup, ["--execute", "--plan", setup.plan], { expectFailure: true });
    ensure(context, rejected.value.message.includes("recomputed AGENTS.md"), "Phase 2 accepted a self-consistent AGENTS lie");
    ensure(context, fs.existsSync(path.join(setup.project, ".kg", "migration", "active-plan.json")), "Phase 2 failure lost recovery state");
    const rolledBack = runMigrationAction(context, setup, ["--rollback", "--plan", setup.plan]);
    ensure(context, rolledBack.value.status === "clean_v1", "Phase 2 failure did not support verified rollback");
    ensure(context, treeHash(setup.project) === original, "Phase 2 failure rollback did not restore v1");
  });

  testCase(context, "kill_matrix_converges_at_every_checkpoint", () => {
    const checkpoints = [
      { name: "before_sealed_plan", deleteExternal: true },
      { name: "after_sealed_plan", deleteExternal: true },
      { name: "after_before_images", deleteExternal: true },
      { name: "during_quarantine_move", quarantine: true },
      { name: "after_quarantine_manifest", quarantine: true, resolve: true },
      { name: "during_skill_replace", deleteExternal: true },
      { name: "after_skill_replace", deleteExternal: true },
      { name: "after_config_write" },
      { name: "after_agents_write" },
      { name: "before_phase2_commit", deleteExternal: true },
    ];
    for (const checkpointCase of checkpoints) {
      const setup = setupMigrationCase(context, `kill-${checkpointCase.name}`);
      if (checkpointCase.quarantine) addInvalidQueueItems(setup);
      let plan = generateMigrationPlan(context, setup);
      const killed = runCheckpointDriver(context, setup, checkpointCase.name, ["--execute", "--plan", setup.plan]);
      ensure(context, killed.ready === checkpointCase.name && killed.signal === "SIGKILL", `${checkpointCase.name} was not killed at confirmation`);
      for (const relative of migrationScaffolding(setup.project)) {
        ensure(context, relative.includes(plan.id), `${checkpointCase.name} left scaffolding outside the active plan: ${relative}`);
      }
      if (checkpointCase.deleteExternal) fs.rmSync(setup.plan, { force: true });

      let recoveryArgs;
      let expectedStatus;
      if (checkpointCase.name === "before_sealed_plan") {
        ensure(context, detectHost(context, setup.project).classification === "v1", "early kill crossed the v1 boundary");
        plan = generateMigrationPlan(context, setup);
        recoveryArgs = ["--execute", "--plan", setup.plan];
        expectedStatus = "complete";
      } else if (checkpointCase.resolve) {
        const resolutionFile = path.join(setup.artifacts, `${checkpointCase.name}-resolution.json`);
        writeJson(resolutionFile, resolutionForPlan(plan));
        recoveryArgs = ["--resolve", resolutionFile, "--plan", setup.plan];
        expectedStatus = "complete";
      } else if (checkpointCase.quarantine) {
        recoveryArgs = ["--execute", "--plan", setup.plan];
        expectedStatus = "blocked_on_quarantine";
      } else {
        recoveryArgs = checkpointCase.deleteExternal ? ["--execute"] : ["--execute", "--plan", setup.plan];
        expectedStatus = "complete";
      }
      const recovered = runMigrationAction(context, setup, recoveryArgs, { expectFailure: expectedStatus === "blocked_on_quarantine" });
      ensure(context, recovered.value.status === expectedStatus, `${checkpointCase.name} recovered to ${recovered.value.status}`);
      if (checkpointCase.name === "during_skill_replace") {
        ensure(
          context,
          recovered.value.actions.some((action) => action.initial_state === "resume"),
          "skill interruption did not expose the resume state",
        );
      }
      if (expectedStatus === "blocked_on_quarantine") {
        ensure(context, recovered.value.actions.some((action) => action.state === "blocked"), "quarantine did not expose blocked state");
      }
      const stable = treeHash(setup.project);
      const repeated = runMigrationAction(context, setup, recoveryArgs, { expectFailure: expectedStatus === "blocked_on_quarantine" });
      ensure(context, repeated.value.status === expectedStatus, `${checkpointCase.name} idempotent rerun changed status`);
      ensure(context, treeHash(setup.project) === stable, `${checkpointCase.name} idempotent rerun changed the tree`);
      ensure(context, migrationScaffolding(setup.project).length === 0, `${checkpointCase.name} recovery left migration scaffolding`);
    }

    const rollback = setupMigrationCase(context, "kill-during-rollback");
    const rollbackOriginal = treeHash(rollback.project);
    generateMigrationPlan(context, rollback);
    executeMigration(context, rollback);
    const rollbackKilled = runCheckpointDriver(
      context,
      rollback,
      "during_rollback_restore",
      ["--rollback", "--plan", rollback.plan],
    );
    ensure(context, rollbackKilled.signal === "SIGKILL", "rollback checkpoint did not receive SIGKILL");
    const rollbackRecovered = runMigrationAction(context, rollback, ["--rollback", "--plan", rollback.plan]);
    ensure(context, rollbackRecovered.value.status === "clean_v1", "rollback checkpoint did not recover to clean v1");
    ensure(context, treeHash(rollback.project) === rollbackOriginal, "rollback checkpoint did not restore the v1 tree");
    const rollbackStable = treeHash(rollback.project);
    runMigrationAction(context, rollback, ["--rollback", "--plan", rollback.plan]);
    ensure(context, treeHash(rollback.project) === rollbackStable, "rollback checkpoint rerun changed clean v1");

    const corrupt = setupMigrationCase(context, "kill-double-plan-corruption");
    const corruptPlan = generateMigrationPlan(context, corrupt);
    runCheckpointDriver(context, corrupt, "after_config_write", ["--execute", "--plan", corrupt.plan]);
    fs.writeFileSync(corrupt.plan, "{corrupt external plan\n");
    fs.writeFileSync(
      path.join(corrupt.project, ".kg", "migration", "plans", `${corruptPlan.id}.json`),
      "{corrupt internal plan\n",
    );
    const corruptTree = treeHash(corrupt.project);
    const manual = runMigrationAction(context, corrupt, ["--execute"], { expectFailure: true });
    ensure(context, manual.value.status === "manual_recovery_required", "double plan corruption did not enter manual recovery");
    ensure(context, treeHash(corrupt.project) === corruptTree, "double plan corruption failure changed the host");

    const missing = setupMigrationCase(context, "kill-both-plans-missing");
    const missingPlan = generateMigrationPlan(context, missing);
    runCheckpointDriver(context, missing, "after_config_write", ["--execute", "--plan", missing.plan]);
    fs.rmSync(missing.plan, { force: true });
    fs.rmSync(path.join(missing.project, ".kg", "migration", "plans", `${missingPlan.id}.json`), { force: true });
    const missingTree = treeHash(missing.project);
    const missingManual = runMigrationAction(context, missing, ["--execute"], { expectFailure: true });
    ensure(context, missingManual.value.status === "manual_recovery_required", "missing plans after the v1 boundary did not enter manual recovery");
    ensure(context, treeHash(missing.project) === missingTree, "missing plan failure changed the host");

    const seam = setupMigrationCase(context, "checkpoint-seam-equivalence");
    generateMigrationPlan(context, seam);
    const nonexistentReady = path.join(seam.artifacts, "unset-seam.ready");
    const normalResult = executeMigration(context, seam);
    ensure(context, normalResult.status === "complete" && !fs.existsSync(nonexistentReady), "unset seam paused or emitted a ready signal");
    const normalTree = treeHash(seam.project);
    fs.rmSync(seam.project, { recursive: true, force: true });
    cloneMigrationProject(seam.project);
    generateMigrationPlan(context, seam);
    const released = runCheckpointDriver(context, seam, "after_config_write", ["--execute", "--plan", seam.plan], "release");
    ensure(context, JSON.parse(released.stdout).status === "complete", "released seam did not complete");
    ensure(context, treeHash(seam.project) === normalTree, "released seam changed the terminal tree");
  });
}

function cloneBootstrapProject(destination, { hazards = false } = {}) {
  fs.cpSync(path.join(BOOTSTRAP_FIXTURE, "host"), destination, { recursive: true });
  if (hazards) {
    fs.mkdirSync(path.join(destination, "lower", ".kg"), { recursive: true });
    fs.writeFileSync(path.join(destination, "lower", ".kg", "uncompiled.yaml"), "forbidden: true\n");
    fs.mkdirSync(path.join(destination, "node_modules", "unsafe-package"), { recursive: true });
    fs.writeFileSync(path.join(destination, "node_modules", "unsafe-package", "index.js"), "throw new Error('unsafe');\n");
    fs.mkdirSync(path.join(destination, "generated"), { recursive: true });
    fs.writeFileSync(path.join(destination, "generated", "client.js"), "generated\n");
    fs.writeFileSync(path.join(destination, "private-key.pem"), "private\n");
    fs.writeFileSync(path.join(destination, "certificate.pem"), "certificate\n");
    fs.writeFileSync(path.join(destination, "credentials.json"), "{}\n");
    fs.writeFileSync(path.join(destination, "api-secret.txt"), "secret\n");
    fs.writeFileSync(path.join(destination, "service.sqlite"), "database\n");
    fs.writeFileSync(path.join(destination, "binary.png"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(destination, "binary.txt"), Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(path.join(destination, "large.txt"), "x".repeat(2048));
    fs.symlinkSync(path.join(destination, "src"), path.join(destination, "linked-src"));
    const outside = path.join(path.dirname(destination), "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, path.join(destination, "outside-link.txt"));
    fs.symlinkSync(path.join(destination, ".KG", "uncompiled.yaml"), path.join(destination, "excluded-link.yaml"));
    const executableDirectory = path.join(destination, "executable-sentinels");
    fs.mkdirSync(executableDirectory);
    for (const name of ["build", "test", "migration", "install"]) {
      fs.writeFileSync(
        path.join(executableDirectory, `${name}.mjs`),
        `import fs from "node:fs";\nfs.writeFileSync(new URL("../${name}.executed", import.meta.url), "executed\\n");\n`,
      );
    }
    const manifest = readJson(path.join(destination, "package.json"));
    manifest.scripts = {
      ...manifest.scripts,
      build: "node executable-sentinels/build.mjs",
      test: "node executable-sentinels/test.mjs",
      migrate: "node executable-sentinels/migration.mjs",
      install: "node executable-sentinels/install.mjs",
    };
    writeJson(path.join(destination, "package.json"), manifest);
  }
}

function setupBootstrapCase(context, name, inventoryArgs = [], beforeInventory = null) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  cloneBootstrapProject(project, { hazards: true });
  if (beforeInventory) beforeInventory(project);
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
  const before = treeHash(setup.project);
  runNode(
    context,
    DOCS_BOOTSTRAP,
    ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
    { cwd: setup.project, expectFailure: true },
  );
  ensure(context, treeHash(setup.project) === before, "failed bootstrap changed the project tree");
}

function factSourcesFromDocument(text) {
  return [...text.matchAll(/^<!-- kg:fact-source (.+) -->$/gm)].map((match) => JSON.parse(match[1]));
}

function bootstrapTaxonomyContract() {
  const taxonomy = protocol.loadDocumentTaxonomy();
  const templates = new Map();
  for (const docType of taxonomy.core_types) {
    const record = taxonomy.documents[docType];
    const templateFile = path.join(ROOT, record.template_path);
    const text = fs.readFileSync(templateFile, "utf8");
    const sections = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->\r?\n## ([^\r\n]+)$/gm)].map(
      (match) => ({ key: match[1], heading: match[2] }),
    );
    ensureTemplateContract(record, templateFile, sections);
    templates.set(docType, { ...record, sections });
  }
  return { taxonomy, templates };
}

function ensureTemplateContract(record, templateFile, sections) {
  if (sections.length === 0) throw new Error(`template has no machine section keys: ${templateFile}`);
  const placeholders = [...fs.readFileSync(templateFile, "utf8").matchAll(/\{\{findings:([a-z][a-z0-9_]*)\}\}/g)]
    .map((match) => match[1]);
  if (JSON.stringify(placeholders) !== JSON.stringify(sections.map((section) => section.key))) {
    throw new Error(`template placeholders drifted from section keys: ${templateFile}`);
  }
  if (typeof record.create_target_pattern !== "string") throw new Error(`taxonomy target pattern missing for ${templateFile}`);
}

function buildV2BootstrapPlan({ taxonomyState, allUnknown = false, coverageLimitations = [] }) {
  const observedSource = { path: "src/server.mjs", line_start: 1, line_end: 1 };
  const secondSource = { path: "package.json", line_start: 5, line_end: 5 };
  let classificationIndex = 0;
  const classifications = [
    { classification: "observed_fact", statement: "The server module imports the order loader.", sources: [observedSource] },
    {
      classification: "inference",
      statement: "The package likely runs as one server process.",
      confidence: 0.75,
      sources: [secondSource],
    },
    {
      classification: "conflict",
      statement: "The module boundary and package entrypoint provide conflicting placement signals.",
      sources: [observedSource, secondSource],
    },
    {
      classification: "unknown",
      statement: "Deployment ownership is undocumented.",
      sources: [],
      missing_evidence: "No deployment ownership record was inventoried.",
    },
  ];
  return {
    kind: "kg.docs_bootstrap_plan",
    version: 2,
    documents: taxonomyState.taxonomy.core_types.map((docType) => {
      const template = taxonomyState.templates.get(docType);
      return {
        doc_type: docType,
        slug: template.create_target_pattern.includes("{slug}") ? `r33-${docType}` : null,
        title: `R3.3 ${docType} bootstrap draft`,
        mode: "create",
        target_path: null,
        coverage_limitations: [...coverageLimitations],
        sections: template.sections.map((section) => {
          const finding = allUnknown || classificationIndex >= classifications.length
            ? {
                classification: "unknown",
                statement: `Evidence for ${docType} ${section.key} remains incomplete.`,
                sources: [],
                missing_evidence: `The static inventory does not establish ${docType} ${section.key}.`,
              }
            : classifications[classificationIndex++];
          return { key: section.key, findings: [structuredClone(finding)] };
        }),
      };
    }),
  };
}

function v2ExpectedTargets(taxonomyState, plan) {
  return plan.documents.map((document) => {
    const template = taxonomyState.templates.get(document.doc_type);
    return template.create_target_pattern
      .replace("{sequence}", "0001")
      .replace("{slug}", document.slug ?? "");
  });
}

function decodeEvidenceMarkers(text) {
  return [...text.matchAll(/^<!-- kg:evidence ([A-Za-z0-9_-]+) -->$/gm)].map((match) =>
    JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
}

function canonicalJsonForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inventoryDigestForTest(inventory) {
  return crypto.createHash("sha256").update(canonicalJsonForTest(inventory)).digest("hex");
}

function contentHashForTest(value) {
  return crypto.createHash("sha256").update(canonicalJsonForTest(value)).digest("hex");
}

function writeManualProjectDocument(project, targetPath, docType, title = `Human ${docType}`) {
  const file = path.join(project, targetPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const frontmatter = {
    kind: "kg.project_document",
    title,
    doc_type: docType,
    status: "draft",
    owners: [],
    supersedes: null,
    source_refs: [],
  };
  fs.writeFileSync(file, `---\n${kyaml.stringify(frontmatter).trimEnd()}\n---\n\n# ${title}\n\nHuman-authored content.\n`);
  return file;
}

function makeAllDocumentsProposals(project, taxonomyState, plan) {
  const targets = v2ExpectedTargets(taxonomyState, plan);
  for (const [index, targetPath] of targets.entries()) {
    const document = plan.documents[index];
    writeManualProjectDocument(project, targetPath, document.doc_type);
    document.mode = "proposal";
    document.target_path = targetPath;
  }
  return targets;
}

function proposalBundles(project) {
  const root = path.join(project, "docs", "proposals");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("bootstrap-"))
    .map((entry) => {
      const bundle = path.join(root, entry.name);
      const manifestFile = path.join(bundle, "manifest.json");
      const candidateFile = path.join(bundle, "candidate.md");
      return { bundle, manifestFile, candidateFile, manifest: readJson(manifestFile) };
    })
    .sort((left, right) => left.bundle.localeCompare(right.bundle));
}

function assertProposalBundle(context, setup, bundle, inventory) {
  const target = path.join(setup.project, bundle.manifest.target_path);
  const targetSha256 = fileHash(target);
  const candidateSha256 = fileHash(bundle.candidateFile);
  const inventorySha256 = inventoryDigestForTest(inventory);
  const contentId = contentHashForTest({
    target_path: bundle.manifest.target_path,
    target_sha256: targetSha256,
    candidate_sha256: candidateSha256,
    inventory_sha256: inventorySha256,
  });
  const proposalId = `bootstrap-${contentId}`;
  const bundlePath = `docs/proposals/${proposalId}`;
  ensure(context, path.basename(bundle.bundle) === proposalId, "proposal directory is not content addressed");
  ensure(
    context,
    canonicalJsonForTest(bundle.manifest) === canonicalJsonForTest({
      kind: "kg.docs_bootstrap_proposal",
      version: 1,
      proposal_id: proposalId,
      doc_type: bundle.manifest.doc_type,
      target_path: bundle.manifest.target_path,
      target_sha256: targetSha256,
      candidate_path: `${bundlePath}/candidate.md`,
      candidate_sha256: candidateSha256,
      inventory_sha256: inventorySha256,
      source_refs: bundle.manifest.source_refs,
      status: "proposed",
    }),
    `proposal manifest fields or hashes are invalid for ${bundle.manifest.target_path}`,
  );
  const candidate = fs.readFileSync(bundle.candidateFile, "utf8");
  const { frontmatter } = protocol.splitFrontmatter(candidate);
  ensure(context, frontmatter.doc_type === bundle.manifest.doc_type && frontmatter.status === "draft", "proposal candidate identity is invalid");
  ensure(context, canonicalJsonForTest(frontmatter.source_refs ?? []) === canonicalJsonForTest(bundle.manifest.source_refs), "proposal source_refs differ from candidate");
}

function canonicalFindingMarkersFromRaw(document) {
  return document.sections.flatMap((section) => section.findings.map((finding) => ({ section: section.key, ...finding })));
}

function runV2Bootstrap(context, setup, plan) {
  writeJson(setup.plan, plan);
  runNode(
    context,
    DOCS_BOOTSTRAP,
    ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
    { cwd: setup.project },
  );
}

function assertRunnerAdapterConformance(context, artifacts, label) {
  const realEnvelope = readJson(REAL_BOOTSTRAP_RUNNER_ENVELOPE);
  const mockEnvelope = readJson(path.join(artifacts, "runner-output.json"));
  ensure(context, validateRunnerResponse(realEnvelope).length === 0, "saved real runner envelope is invalid");
  ensure(context, validateRunnerResponse(mockEnvelope).length === 0, `${label} mock runner envelope is invalid`);
  ensure(
    context,
    canonicalJsonForTest(runnerEnvelopeConformanceProfile(mockEnvelope)) ===
      canonicalJsonForTest(runnerEnvelopeConformanceProfile(realEnvelope)),
    `${label} mock runner fields or path forms differ from the saved real envelope`,
  );
  for (const field of ["session_id", "transcript", "file_reads", "citations", "products", "tool_events", "permission_denials"]) {
    const realMissing = structuredClone(realEnvelope);
    const mockMissing = structuredClone(mockEnvelope);
    delete realMissing[field];
    delete mockMissing[field];
    ensure(
      context,
      canonicalJsonForTest(validateRunnerResponse(realMissing)) === canonicalJsonForTest(validateRunnerResponse(mockMissing)),
      `${label} missing ${field} verdict differs from the saved real envelope`,
    );
  }

  const artifactRoot = path.join(artifacts, "session");
  const inventoryProduct = mockEnvelope.products.find((product) => product.kind === "kg.repository_inventory");
  const absoluteArtifact = normalizeRunnerArtifactProduct(inventoryProduct, artifactRoot, "inventory");
  const relativeArtifact = normalizeRunnerArtifactProduct(
    { ...inventoryProduct, path: path.relative(artifactRoot, absoluteArtifact) },
    artifactRoot,
    "inventory",
  );
  ensure(context, host.canonicalPath(absoluteArtifact) === host.canonicalPath(relativeArtifact), `${label} artifact path relativization drifted`);
  const artifactLink = path.join(artifactRoot, `adapter-${label}.json`);
  fs.symlinkSync(absoluteArtifact, artifactLink);
  let artifactLinkRejected = false;
  try {
    normalizeRunnerArtifactProduct({ ...inventoryProduct, path: path.basename(artifactLink) }, artifactRoot, "inventory");
  } catch (error) {
    artifactLinkRejected = error.message.includes("symbolic link");
  }
  ensure(context, artifactLinkRejected, `${label} artifact symlink was accepted`);

  const projectRoot = path.join(artifacts, "workspace", "project");
  const projectProduct = mockEnvelope.products.find((product) =>
    ["kg.project_document", "kg.project_document_candidate"].includes(product.kind));
  const projectRelative = normalizeRunnerProjectProduct(projectRoot, projectProduct, "project document");
  const projectLink = path.join(projectRoot, `adapter-${label}.md`);
  fs.symlinkSync(path.join(projectRoot, projectRelative), projectLink);
  let projectLinkRejected = false;
  try {
    normalizeRunnerProjectProduct(projectRoot, { ...projectProduct, path: path.basename(projectLink) }, "project document");
  } catch (error) {
    projectLinkRejected = error.message.includes("symbolic link");
  }
  ensure(context, projectLinkRejected, `${label} project product symlink was accepted`);
}

function runPart2(context) {
  testCase(context, "live_and_check_modes_share_canonical_path_semantics", () => {
    const canonicalRoot = path.join(context.root, "path-semantics", "artifacts");
    const declaredAlias = path.join(context.root, "path-semantics", "artifacts-alias");
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.writeFileSync(path.join(canonicalRoot, "product.json"), "{}\n");
    fs.symlinkSync(canonicalRoot, declaredAlias, "dir");
    const envelope = { products: [{ kind: "fixture", path: "product.json" }] };
    const checkVerdict = host.resolveProductPath(canonicalRoot, envelope.products[0].path, { label: "check product" });
    const liveVerdict = host.resolveProductPath(declaredAlias, envelope.products[0].path, { label: "live product" });
    ensure(context, checkVerdict.verdict === liveVerdict.verdict, "live and check acceptance verdicts differ");
    ensure(context, checkVerdict.canonical === liveVerdict.canonical, "live and check canonical products differ");

    const internal = path.join(canonicalRoot, "internal");
    fs.mkdirSync(internal);
    fs.writeFileSync(path.join(internal, "product.json"), "{}\n");
    fs.symlinkSync(internal, path.join(canonicalRoot, "nested-link"), "dir");
    const rejected = [];
    for (const root of [canonicalRoot, declaredAlias]) {
      try {
        host.resolveProductPath(root, "nested-link/product.json", { label: "runner product" });
        rejected.push("accepted");
      } catch (error) {
        rejected.push(error.message);
      }
    }
    ensure(context, rejected[0] === rejected[1] && rejected[0].includes("symbolic link"), "symlink differential verdicts differ");
  });

  testCase(context, "v1_architecture_plan_remains_compatible", () => {
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

  testCase(context, "bootstrap_creates_all_eight_core_document_types", () => {
    const setup = setupBootstrapCase(context, "v2-all-types");
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState });
    runV2Bootstrap(context, setup, plan);
    const targets = v2ExpectedTargets(taxonomyState, plan);
    ensure(context, targets.length === taxonomyState.taxonomy.core_types.length, "target count differs from taxonomy core_types");
    for (const [index, targetPath] of targets.entries()) {
      const text = fs.readFileSync(path.join(setup.project, targetPath), "utf8");
      const { frontmatter } = protocol.splitFrontmatter(text);
      const document = plan.documents[index];
      ensure(context, frontmatter.doc_type === document.doc_type, `rendered doc_type mismatch for ${targetPath}`);
      ensure(context, frontmatter.status === "draft", `rendered status mismatch for ${targetPath}`);
      const sectionKeys = [...text.matchAll(/^<!-- kg:section ([a-z][a-z0-9_]*) -->$/gm)].map((match) => match[1]);
      const templateKeys = taxonomyState.templates.get(document.doc_type).sections.map((section) => section.key);
      ensure(context, canonicalJsonForTest(sectionKeys) === canonicalJsonForTest(templateKeys), `template section drift for ${targetPath}`);
    }
    const validation = runNode(context, DOCS_VALIDATE, targets.map((target) => path.join(setup.project, target)), {
      cwd: setup.project,
      env: { KG_ROOT: setup.project },
    });
    ensure(context, validation.stdout.includes(`${targets.length}/${targets.length} registered project document(s) valid`), "eight-document validator did not pass");
    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--check", "--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
      { cwd: setup.project },
    );
  });

  testCase(context, "rendered_evidence_exactly_matches_canonical_plan", () => {
    const setup = setupBootstrapCase(context, "v2-evidence");
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState });
    runV2Bootstrap(context, setup, plan);
    const digest = inventoryDigestForTest(readJson(setup.inventory));
    const targets = v2ExpectedTargets(taxonomyState, plan);
    for (const [index, targetPath] of targets.entries()) {
      const document = plan.documents[index];
      const text = fs.readFileSync(path.join(setup.project, targetPath), "utf8");
      const markers = decodeEvidenceMarkers(text);
      const documentMarker = markers.shift();
      ensure(
        context,
        canonicalJsonForTest(documentMarker) === canonicalJsonForTest({
          kind: "kg.bootstrap_document",
          version: 2,
          inventory_sha256: digest,
          doc_type: document.doc_type,
          target_path: targetPath,
          coverage_limitations: document.coverage_limitations,
        }),
        `document evidence marker differs for ${targetPath}`,
      );
      ensure(
        context,
        canonicalJsonForTest(markers) === canonicalJsonForTest(canonicalFindingMarkersFromRaw(document)),
        `finding evidence markers differ for ${targetPath}`,
      );
      const expectedRefs = [...new Set(document.sections.flatMap((section) =>
        section.findings.flatMap((finding) => finding.sources.map((source) => {
          const suffix = source.line_start === source.line_end ? `#L${source.line_start}` : `#L${source.line_start}-L${source.line_end}`;
          return `${source.path}${suffix}`;
        }))))];
      const { frontmatter } = protocol.splitFrontmatter(text);
      ensure(context, canonicalJsonForTest(frontmatter.source_refs) === canonicalJsonForTest(expectedRefs), `source_refs differ for ${targetPath}`);
    }
  });

  testCase(context, "classification_rules_for_fact_inference_conflict_unknown", () => {
    const setup = setupBootstrapCase(context, "v2-classification");
    const taxonomyState = bootstrapTaxonomyContract();
    const positive = buildV2BootstrapPlan({ taxonomyState });
    runV2Bootstrap(context, setup, positive);
    const classifications = new Set(v2ExpectedTargets(taxonomyState, positive).flatMap((target) =>
      decodeEvidenceMarkers(fs.readFileSync(path.join(setup.project, target), "utf8"))
        .filter((marker) => marker.classification)
        .map((marker) => marker.classification)));
    ensure(context, canonicalJsonForTest([...classifications].sort()) === canonicalJsonForTest(Object.keys(FINDING_FIELDS_FOR_TEST).sort()), "rendered classifications are incomplete");

    const mutations = [
      ["observed-empty", (finding) => { finding.sources = []; }],
      ["inference-no-confidence", (finding) => { delete finding.confidence; }],
      ["inference-out-of-range", (finding) => { finding.confidence = 1.1; }],
      ["conflict-one-source", (finding) => { finding.sources = finding.sources.slice(0, 1); }],
      ["conflict-duplicate-source", (finding) => { finding.sources = [finding.sources[0], finding.sources[0]]; }],
      ["unknown-no-reason", (finding) => { delete finding.missing_evidence; }],
      ["unknown-with-source", (finding) => { finding.sources = [{ path: "src/server.mjs", line_start: 1, line_end: 1 }]; }],
    ];
    for (const [name, mutate] of mutations) {
      const negative = setupBootstrapCase(context, `v2-classification-${name}`);
      const plan = buildV2BootstrapPlan({ taxonomyState });
      const findings = plan.documents.flatMap((document) => document.sections.flatMap((section) => section.findings));
      const classification = name.startsWith("observed-") ? "observed_fact" : name.split("-")[0];
      mutate(findings.find((finding) => finding.classification === classification));
      expectBootstrapFailure(context, negative, plan);
    }
  });

  testCase(context, "eight_document_batch_is_atomic", () => {
    const taxonomyState = bootstrapTaxonomyContract();
    const invalid = setupBootstrapCase(context, "v2-atomic-invalid-last");
    const invalidPlan = buildV2BootstrapPlan({ taxonomyState });
    invalidPlan.documents.at(-1).sections.at(-1).findings = [];
    expectBootstrapFailure(context, invalid, invalidPlan);

    const occupied = setupBootstrapCase(context, "v2-atomic-existing-last");
    const occupiedPlan = buildV2BootstrapPlan({ taxonomyState });
    const lastTarget = v2ExpectedTargets(taxonomyState, occupiedPlan).at(-1);
    fs.mkdirSync(path.dirname(path.join(occupied.project, lastTarget)), { recursive: true });
    fs.writeFileSync(path.join(occupied.project, lastTarget), "human-authored glossary\n");
    expectBootstrapFailure(context, occupied, occupiedPlan);
    ensure(context, fs.readFileSync(path.join(occupied.project, lastTarget), "utf8") === "human-authored glossary\n", "occupied target bytes changed");
  });

  testCase(context, "existing_target_produces_content_addressed_proposal", () => {
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState });
    const architecture = plan.documents.find((document) => document.doc_type === "architecture");
    const targetPath = taxonomyState.templates.get("architecture").create_target_pattern;
    const setup = setupBootstrapCase(context, "v2-proposal-existing", [], (project) => {
      writeManualProjectDocument(project, targetPath, "architecture", "Human architecture");
    });
    architecture.mode = "proposal";
    architecture.target_path = targetPath;
    const target = path.join(setup.project, targetPath);
    const before = fileHash(target);
    runV2Bootstrap(context, setup, plan);
    ensure(context, fileHash(target) === before, "proposal changed the human target bytes");
    const bundles = proposalBundles(setup.project);
    ensure(context, bundles.length === 1, "proposal run did not create exactly one bundle");
    assertProposalBundle(context, setup, bundles[0], readJson(setup.inventory));
    const validation = runNode(context, DOCS_VALIDATE, [bundles[0].candidateFile], {
      cwd: setup.project,
      env: { KG_ROOT: setup.project },
    });
    ensure(context, validation.stdout.includes("1/1 registered project document(s) valid"), "proposal candidate validator did not pass");
    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--check", "--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan],
      { cwd: setup.project },
    );
  });

  testCase(context, "proposal_rerun_is_idempotent_and_target_is_unchanged", () => {
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState });
    let targets;
    const setup = setupBootstrapCase(context, "v2-proposal-idempotent", [], (project) => {
      targets = makeAllDocumentsProposals(project, taxonomyState, plan);
    });
    const beforeHashes = new Map(targets.map((target) => [target, fileHash(path.join(setup.project, target))]));
    runV2Bootstrap(context, setup, plan);
    const firstTree = treeHash(setup.project);
    const firstBundles = proposalBundles(setup.project);
    ensure(context, firstBundles.length === targets.length, "all-proposal batch bundle count mismatch");
    runV2Bootstrap(context, setup, plan);
    ensure(context, treeHash(setup.project) === firstTree, "identical proposal rerun changed the project tree");
    ensure(context, proposalBundles(setup.project).length === firstBundles.length, "identical proposal rerun created duplicate bundles");
    for (const target of targets) {
      ensure(context, fileHash(path.join(setup.project, target)) === beforeHashes.get(target), `proposal rerun changed ${target}`);
    }
  });

  testCase(context, "proposal_rejects_target_drift", () => {
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState });
    let targets;
    const setup = setupBootstrapCase(context, "v2-proposal-drift", [], (project) => {
      targets = makeAllDocumentsProposals(project, taxonomyState, plan);
    });
    runV2Bootstrap(context, setup, plan);
    const originalBundles = proposalBundles(setup.project).map((bundle) => path.basename(bundle.bundle));
    fs.appendFileSync(path.join(setup.project, targets[0]), "\nHuman edit after inventory.\n");
    expectBootstrapFailure(context, setup, plan);
    ensure(
      context,
      canonicalJsonForTest(proposalBundles(setup.project).map((bundle) => path.basename(bundle.bundle))) === canonicalJsonForTest(originalBundles),
      "target drift created or replaced a proposal bundle",
    );
  });

  testCase(context, "rejects_unknown_and_script_owned_fields", () => {
    const setup = setupBootstrapCase(context, "unknown-plan");
    const plan = readJson(setup.plan);
    plan.status = "accepted";
    plan.created_at = FIXED_NOW;
    expectBootstrapFailure(context, setup, plan);

    const taxonomyState = bootstrapTaxonomyContract();
    for (const [name, mutate] of [
      ["inventory-hash", (value) => { value.inventory_sha256 = "a".repeat(64); }],
      ["document-status", (value) => { value.documents[0].status = "accepted"; }],
      ["document-id", (value) => { value.documents[0].id = "DOC-0001"; }],
      ["finding-created-at", (value) => { value.documents[0].sections[0].findings[0].created_at = FIXED_NOW; }],
    ]) {
      const negative = setupBootstrapCase(context, `unknown-v2-${name}`);
      const value = buildV2BootstrapPlan({ taxonomyState });
      mutate(value);
      expectBootstrapFailure(context, negative, value);
    }
  });

  testCase(context, "rejects_uninventoried_out_of_range_and_drifted_sources", () => {
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
    const taxonomyState = bootstrapTaxonomyContract();
    for (const variant of ["uninventoried", "out-of-range"]) {
      const setup = setupBootstrapCase(context, `bad-v2-source-${variant}`);
      const plan = buildV2BootstrapPlan({ taxonomyState });
      const finding = plan.documents[0].sections[0].findings[0];
      if (variant === "uninventoried") finding.sources[0].path = "src/missing.mjs";
      if (variant === "out-of-range") finding.sources[0].line_end = 999;
      expectBootstrapFailure(context, setup, plan);
    }
    const drifted = setupBootstrapCase(context, "bad-v2-source-drift");
    const driftedPlan = buildV2BootstrapPlan({ taxonomyState });
    fs.appendFileSync(path.join(drifted.project, "src", "server.mjs"), "\n// changed after inventory\n");
    expectBootstrapFailure(context, drifted, driftedPlan);
  });

  testCase(context, "rejects_truncation_without_coverage_limitations", () => {
    const setup = setupBootstrapCase(context, "truncated", ["--max-files", "1"]);
    const inventory = readJson(setup.inventory);
    ensure(context, inventory.truncated === true, "max-files inventory did not report truncation");
    const plan = readJson(setup.plan);
    plan.coverage_limitations = [];
    expectBootstrapFailure(context, setup, plan);

    const taxonomyState = bootstrapTaxonomyContract();
    const v2 = setupBootstrapCase(context, "truncated-v2", ["--max-files", "1"]);
    const rejected = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    expectBootstrapFailure(context, v2, rejected);

    const accepted = setupBootstrapCase(context, "truncated-v2-covered", ["--max-files", "1"]);
    const limitation = "The max_files limit truncated repository coverage.";
    const acceptedPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true, coverageLimitations: [limitation] });
    runV2Bootstrap(context, accepted, acceptedPlan);
    for (const target of v2ExpectedTargets(taxonomyState, acceptedPlan)) {
      const text = fs.readFileSync(path.join(accepted.project, target), "utf8");
      const { frontmatter } = protocol.splitFrontmatter(text);
      const documentMarker = decodeEvidenceMarkers(text)[0];
      ensure(context, canonicalJsonForTest(frontmatter.coverage_limitations) === canonicalJsonForTest([limitation]), `frontmatter lost coverage limitation: ${target}`);
      ensure(context, canonicalJsonForTest(documentMarker.coverage_limitations) === canonicalJsonForTest([limitation]), `evidence marker lost coverage limitation: ${target}`);
    }
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

  testCase(context, "v1_source_drift_remains_rejected", () => {
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

  testCase(context, "kn0016_exclusion_matrix_is_complete", () => {
    const setup = setupBootstrapCase(context, "kn0016-complete-matrix");
    const inventory = readJson(setup.inventory);
    const safePaths = inventory.files.map((file) => file.path);
    const excludedPaths = [
      "lower/.kg/uncompiled.yaml",
      ".KG/uncompiled.yaml",
      "mixed/.kG/mixed-case.yaml",
      ".env",
      "credentials.json",
      "private-key.pem",
      "certificate.pem",
      "service.sqlite",
      "api-secret.txt",
      "secrets/notes.txt",
      "binary.png",
      "binary.txt",
      "large.txt",
      "node_modules/unsafe-package/index.js",
      "generated/client.js",
      "linked-src/server.mjs",
      "outside-link.txt",
      "excluded-link.yaml",
    ];
    for (const forbidden of excludedPaths) {
      ensure(
        context,
        !safePaths.some((item) => item === forbidden || item.startsWith(`${forbidden}/`)),
        `excluded KN-0016 path entered inventory: ${forbidden}`,
      );
    }
    ensure(context, inventory.stats.excluded_kg_directories >= 3, "mixed-case .kg matrix is incomplete");
    ensure(context, inventory.stats.excluded_sensitive_files >= 6, "sensitive material matrix is incomplete");
    ensure(context, inventory.stats.excluded_sensitive_directories >= 1, "sensitive directory matrix is incomplete");
    ensure(context, inventory.stats.excluded_binary_files >= 2, "binary matrix is incomplete");
    ensure(context, inventory.stats.excluded_oversized_files >= 1, "oversized matrix is incomplete");
    ensure(context, inventory.stats.excluded_directories >= 2, "dependency or generated directory matrix is incomplete");
    ensure(context, inventory.stats.excluded_symlinks >= 3, "symlink matrix is incomplete");

    const taxonomyState = bootstrapTaxonomyContract();
    for (const excluded of excludedPaths) {
      const plan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
      plan.documents[0].sections[0].findings[0] = {
        classification: "observed_fact",
        statement: `Excluded source ${excluded} must be rejected.`,
        sources: [{ path: excluded, line_start: 1, line_end: 1 }],
      };
      expectBootstrapFailure(context, setup, plan);
    }

    const manual = setupBootstrapCase(context, "kn0016-direct-create-existing", [], (project) => {
      writeManualProjectDocument(project, "docs/architecture/overview.md", "architecture");
    });
    const manualPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    const manualHash = fileHash(path.join(manual.project, "docs/architecture/overview.md"));
    expectBootstrapFailure(context, manual, manualPlan);
    ensure(context, fileHash(path.join(manual.project, "docs/architecture/overview.md")) === manualHash, "direct create changed an existing human document");

    const lastInvalid = setupBootstrapCase(context, "kn0016-last-invalid");
    const lastInvalidPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    lastInvalidPlan.documents.at(-1).sections.at(-1).findings = [];
    expectBootstrapFailure(context, lastInvalid, lastInvalidPlan);

    const drifted = setupBootstrapCase(context, "kn0016-inventory-drift");
    fs.appendFileSync(path.join(drifted.project, "src", "server.mjs"), "\n// post-inventory drift\n");
    expectBootstrapFailure(context, drifted, buildV2BootstrapPlan({ taxonomyState, allUnknown: true }));

    const truncated = setupBootstrapCase(context, "kn0016-truncated-no-coverage", ["--max-files", "1"]);
    ensure(context, readJson(truncated.inventory).truncated === true, "KN-0016 truncation fixture did not truncate");
    expectBootstrapFailure(context, truncated, buildV2BootstrapPlan({ taxonomyState, allUnknown: true }));

    const runtimeInventory = path.join(setup.artifacts, "runtime-inventory.json");
    runNode(
      context,
      DOCS_INVENTORY,
      ["--root", setup.project, "--output", runtimeInventory, "--runtime-verification"],
      { cwd: setup.project, expectFailure: true },
    );
    ensure(context, !fs.existsSync(runtimeInventory), "unauthorized runtime inventory request produced output");
    runNode(
      context,
      DOCS_BOOTSTRAP,
      ["--project-root", setup.project, "--inventory", setup.inventory, "--plan", setup.plan, "--runtime-verification"],
      { cwd: setup.project, expectFailure: true },
    );
    for (const marker of ["should-not-run.executed", "build.executed", "test.executed", "migration.executed", "install.executed"]) {
      ensure(context, !fs.existsSync(path.join(setup.project, marker)), `host execution sentinel fired: ${marker}`);
    }
  });

  testCase(context, "rejects_symlink_escape_and_mixed_case_kg_paths", () => {
    const taxonomyState = bootstrapTaxonomyContract();

    const targetLinkPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    const targetLink = setupBootstrapCase(context, "proposal-target-symlink", [], (project) => {
      const source = writeManualProjectDocument(project, "manual/architecture.md", "architecture");
      const target = path.join(project, "docs", "architecture", "overview.md");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(target), source), target);
    });
    targetLinkPlan.documents[0].mode = "proposal";
    targetLinkPlan.documents[0].target_path = "docs/architecture/overview.md";
    expectBootstrapFailure(context, targetLink, targetLinkPlan);

    const parentLinkPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    const standardDocument = parentLinkPlan.documents.find((document) => document.doc_type === "standard");
    const standardPath = taxonomyState.templates.get("standard").create_target_pattern.replace("{slug}", standardDocument.slug);
    const parentLink = setupBootstrapCase(context, "proposal-target-parent-symlink", [], (project) => {
      const target = writeManualProjectDocument(project, `manual/${standardDocument.slug}.md`, "standard");
      fs.mkdirSync(path.join(project, "docs"), { recursive: true });
      fs.symlinkSync(path.dirname(target), path.join(project, "docs", "standards"));
    });
    standardDocument.mode = "proposal";
    standardDocument.target_path = standardPath;
    expectBootstrapFailure(context, parentLink, parentLinkPlan);

    const bundleLinkPlan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    const bundleLink = setupBootstrapCase(context, "proposal-bundle-parent-symlink", [], (project) => {
      writeManualProjectDocument(project, "docs/architecture/overview.md", "architecture");
      fs.mkdirSync(path.join(project, "proposal-storage"));
      fs.symlinkSync(path.join(project, "proposal-storage"), path.join(project, "docs", "proposals"));
    });
    bundleLinkPlan.documents[0].mode = "proposal";
    bundleLinkPlan.documents[0].target_path = "docs/architecture/overview.md";
    expectBootstrapFailure(context, bundleLink, bundleLinkPlan);

    for (const [index, mixedCasePath] of ["lower/.kg/uncompiled.yaml", ".KG/uncompiled.yaml", "mixed/.kG/mixed-case.yaml"].entries()) {
      const mixed = setupBootstrapCase(context, `mixed-case-${index + 1}`);
      const plan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
      plan.documents[0].sections[0].findings[0] = {
        classification: "observed_fact",
        statement: "Mixed-case .kg paths are excluded.",
        sources: [{ path: mixedCasePath, line_start: 1, line_end: 1 }],
      };
      expectBootstrapFailure(context, mixed, plan);
    }
  });

  testCase(context, "kn0016_host_code_never_executes", () => {
    const setup = setupBootstrapCase(context, "kn0016-static-boundary");
    const inventory = readJson(setup.inventory);
    const safePaths = inventory.files.map((file) => file.path);
    for (const forbidden of [
      "lower/.kg/uncompiled.yaml",
      ".KG/uncompiled.yaml",
      "mixed/.kG/mixed-case.yaml",
      ".env",
      "secrets/notes.txt",
      "private-key.pem",
      "service.sqlite",
      "binary.png",
      "binary.txt",
      "large.txt",
      "node_modules/unsafe-package/index.js",
      "generated/client.js",
      "linked-src",
      "outside-link.txt",
      "excluded-link.yaml",
    ]) {
      ensure(context, !safePaths.some((item) => item === forbidden || item.startsWith(`${forbidden}/`)), `KN-0016 exclusion failed: ${forbidden}`);
    }
    ensure(context, inventory.stats.excluded_kg_directories >= 3, "three mixed-case .kg directories were not excluded");
    ensure(context, inventory.stats.excluded_symlinks >= 3, "symlink classes were not excluded");
    ensure(context, !fs.existsSync(path.join(setup.project, "should-not-run.executed")), "inventory executed host code");
    const taxonomyState = bootstrapTaxonomyContract();
    const plan = buildV2BootstrapPlan({ taxonomyState, allUnknown: true });
    runV2Bootstrap(context, setup, plan);
    ensure(context, !fs.existsSync(path.join(setup.project, "should-not-run.executed")), "renderer executed host code");

    const forged = setupBootstrapCase(context, "kn0016-forged-inventory");
    const forgedInventory = readJson(forged.inventory);
    const secret = fs.readFileSync(path.join(forged.project, ".env"));
    forgedInventory.files.push({
      path: ".env",
      kind: "text",
      bytes: secret.byteLength,
      line_count: secret.toString("utf8").split(/\r?\n/).length,
      sha256: crypto.createHash("sha256").update(secret).digest("hex"),
    });
    forgedInventory.stats.safe_files += 1;
    writeJson(forged.inventory, forgedInventory);
    expectBootstrapFailure(context, forged, buildV2BootstrapPlan({ taxonomyState, allUnknown: true }));
  });

  testCase(context, "real_runner_adapter_cannot_invent_read_evidence", () => {
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
    assertRunnerAdapterConformance(context, passingArtifacts, "v1");

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

    const v2Artifacts = path.join(context.root, "gb3-evaluator-v2-pass");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", BOOTSTRAP_V2_EVAL_FIXTURE, "--artifacts", v2Artifacts],
      { cwd: ROOT, env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_V2_RUNNER } },
    );
    const v2Result = readJson(path.join(v2Artifacts, "result.json"));
    ensure(context, v2Result.pass === true, "version 2 G-B3 evaluator fixture did not pass");
    const oracleAudit = readJson(path.join(v2Artifacts, "oracle-isolation-audit.json"));
    ensure(context, oracleAudit.pass === true && oracleAudit.checked_values === 4, "version 2 oracle isolation audit did not pass");
    ensure(context, readJson(path.join(v2Artifacts, "products.json")).filter((item) => item.kind === "kg.project_document").length === 8, "version 2 evaluator lost document products");
    assertRunnerAdapterConformance(context, v2Artifacts, "v2");

    const proposalArtifacts = path.join(context.root, "gb4-evaluator-proposal-pass");
    runNode(
      context,
      EVAL_BOOTSTRAP,
      ["--fixture", BOOTSTRAP_PROPOSAL_EVAL_FIXTURE, "--artifacts", proposalArtifacts],
      { cwd: ROOT, env: { KG_EVAL_RUNNER: MOCK_BOOTSTRAP_V2_RUNNER } },
    );
    const proposalResult = readJson(path.join(proposalArtifacts, "result.json"));
    ensure(context, proposalResult.pass === true, "proposal G-B4 evaluator fixture did not pass");
    const proposalProducts = readJson(path.join(proposalArtifacts, "products.json"));
    ensure(context, proposalProducts.filter((item) => item.kind === "kg.project_document").length === 6, "proposal evaluator lost direct draft products");
    ensure(context, proposalProducts.filter((item) => item.kind === "kg.docs_bootstrap_proposal").length === 2, "proposal evaluator lost manifest products");
    ensure(context, proposalProducts.filter((item) => item.kind === "kg.project_document_candidate").length === 2, "proposal evaluator lost candidate products");
    ensure(
      context,
      readJson(path.join(proposalArtifacts, "target-hashes.json")).every((item) => item.before_sha256 === item.after_sha256),
      "proposal evaluator did not preserve target hashes",
    );
    assertRunnerAdapterConformance(context, proposalArtifacts, "proposal");
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
  testCase(context, "validator_self_check_is_host_isolated", () => {
    const sentinel = setupObservationHost(context, "self-check-sentinel");
    const pending = path.join(sentinel.project, ".kg", "observations", "unreadable-sentinel.yaml");
    fs.writeFileSync(pending, "this is deliberately invalid\n");
    const before = fileHash(pending);
    const checked = runNode(context, OBSERVE_VALIDATE, ["--self-check"], {
      cwd: sentinel.project,
      env: observationEnv(sentinel.project),
    });
    ensure(context, checked.stdout.includes("in-memory"), "observation self-check did not use its isolated path");
    ensure(context, fileHash(pending) === before, "observation self-check changed the host inbox");
  });

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

function setupCompileCase(context, name, planName, observationId) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.cpSync(path.join(COMPILE_FIXTURE, "host"), project, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const observations = path.join(project, ".kg", "observations");
  for (const file of fs.readdirSync(observations)) {
    if (file.endsWith(".yaml") && file !== `${observationId}.yaml`) fs.rmSync(path.join(observations, file));
  }
  const compileContext = path.join(artifacts, "compile-context.json");
  const plan = path.join(artifacts, "compile-plan.json");
  fs.copyFileSync(path.join(COMPILE_FIXTURE, planName), plan);
  runNode(
    context,
    COMPILE_CONTEXT,
    ["--root", project, "--output", compileContext, "--now", "2026-07-31T02:00:00Z"],
    { cwd: project, env: { KG_ROOT: project } },
  );
  return { caseRoot, project, artifacts, context: compileContext, plan, observationId };
}

function applyCompile(context, setup, options = {}) {
  return runNode(
    context,
    COMPILE_APPLY,
    [
      "--root",
      setup.project,
      "--context",
      setup.context,
      "--plan",
      setup.plan,
      "--now",
      "2026-07-31T02:00:00Z",
    ],
    {
      cwd: setup.project,
      env: { KG_ROOT: setup.project, ...(options.env ?? {}) },
      expectFailure: options.expectFailure,
    },
  );
}

function compileReports(project) {
  return fs
    .readdirSync(path.join(project, ".kg", "reports"))
    .filter((name) => /^COMPILE-[a-f0-9]+\.json$/.test(name))
    .sort();
}

function knowledgeFiles(project) {
  return fs
    .readdirSync(path.join(project, "knowledge"))
    .filter((name) => /^KN-[0-9]{4}.*\.md$/.test(name))
    .sort();
}

function readKnowledge(file) {
  return protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
}

function readKyaml(file) {
  return kyaml.parse(fs.readFileSync(file, "utf8"));
}

function assertCompileFailurePreservesHost(context, setup, options = {}) {
  const before = treeHash(setup.project);
  const rejected = applyCompile(context, setup, { ...options, expectFailure: true });
  ensure(context, treeHash(setup.project) === before, "compile preflight failure changed host state");
  return rejected;
}

function mutatePlan(setup, callback) {
  const plan = readJson(setup.plan);
  callback(plan);
  writeJson(setup.plan, plan);
}

function outsideArtifactBlock(text, artifactId) {
  const block = harness.inspectManagedBlock(text, artifactId);
  return `${text.slice(0, block.begin.index + block.begin.text.length)}\n<managed>\n${text.slice(block.end.index)}`;
}

function runPart4(context) {
  testCase(context, "human_edit_between_sessions_is_refresh_not_tamper", () => {
    const document = [
      "title\r\n",
      "<!-- kg:co-managed HAR-REFRESH human begin -->\r\n",
      "human bytes v1\r\n",
      "<!-- kg:co-managed HAR-REFRESH human end -->\r\n",
      "<!-- kg:co-managed HAR-REFRESH machine begin -->\r\n",
      "machine bytes v1\r\n",
      "<!-- kg:co-managed HAR-REFRESH machine end -->\r\n",
      "tail\r\n",
    ].join("");
    const first = harness.inspectCoManagedBlock(Buffer.from(document, "utf8"), "HAR-REFRESH");
    const secondDocument = document.replace("human bytes v1", "human bytes v2");
    const second = harness.inspectCoManagedBlock(Buffer.from(secondDocument, "utf8"), "HAR-REFRESH");
    ensure(context, first.human_segment_hash !== second.human_segment_hash, "human edit did not change the observed hash");
    ensure(context, harness.humanSegmentHashState(first.human_segment_hash, second.human_segment_hash) === "refresh", "cross-session human edit was not classified as refresh");
    const applied = harness.replaceCoManagedMachineSegment(secondDocument, "HAR-REFRESH", "machine bytes v2");
    const after = harness.inspectCoManagedBlock(Buffer.from(applied, "utf8"), "HAR-REFRESH");
    harness.assertTransactionByteFence(second, after);
    ensure(context, after.human_segment_hash === second.human_segment_hash, "refresh did not persist the new human hash observation");
    ensure(context, after.humanBytes.equals(second.humanBytes), "human bytes changed during the second transaction");
  });

  testCase(context, "managed_and_co_managed_parsers_reject_marker_corruption_and_preserve_crlf_bytes", () => {
    const managed = "head\r\n<!-- kg:managed HAR-CRLF begin -->\r\nold\r\n<!-- kg:managed HAR-CRLF end -->\r\ntail\r\n";
    const inspected = harness.inspectManagedBlock(Buffer.from(managed, "utf8"), "HAR-CRLF");
    const updated = harness.replaceManagedBlock(Buffer.from(managed, "utf8"), "HAR-CRLF", "new");
    const updatedBytes = Buffer.from(updated, "utf8");
    const updatedInspection = harness.inspectManagedBlock(updatedBytes, "HAR-CRLF");
    ensure(context, updatedBytes.subarray(0, inspected.machineStartOffset).equals(inspected.prefixBytes), "managed prefix bytes changed under CRLF input");
    ensure(context, updatedInspection.suffixBytes.equals(inspected.suffixBytes), "managed suffix bytes changed under CRLF input");
    harness.assertTransactionByteFence(inspected, updatedInspection);

    const co = [
      "<!-- kg:co-managed HAR-CORRUPT human begin -->\n",
      "human\n",
      "<!-- kg:co-managed HAR-CORRUPT human end -->\n",
      "<!-- kg:co-managed HAR-CORRUPT machine begin -->\n",
      "machine\n",
      "<!-- kg:co-managed HAR-CORRUPT machine end -->\n",
    ].join("");
    const variants = [
      ["missing", co.replace("<!-- kg:co-managed HAR-CORRUPT human end -->\n", "")],
      ["duplicate", co.replace("<!-- kg:co-managed HAR-CORRUPT human begin -->", "<!-- kg:co-managed HAR-CORRUPT human begin -->\n<!-- kg:co-managed HAR-CORRUPT human begin -->")],
      ["crossed", co.replace("<!-- kg:co-managed HAR-CORRUPT machine begin -->\n", "<!-- kg:co-managed HAR-CORRUPT machine begin -->\n").replace("<!-- kg:co-managed HAR-CORRUPT human end -->\n", "<!-- kg:co-managed HAR-CORRUPT human end -->\n")],
    ];
    const crossed = [
      "<!-- kg:co-managed HAR-CORRUPT human begin -->\n",
      "human\n",
      "<!-- kg:co-managed HAR-CORRUPT machine begin -->\n",
      "machine\n",
      "<!-- kg:co-managed HAR-CORRUPT human end -->\n",
      "<!-- kg:co-managed HAR-CORRUPT machine end -->\n",
    ].join("");
    variants[2][1] = crossed;
    for (const [name, value] of variants) {
      let rejected = false;
      try {
        harness.inspectCoManagedBlock(value, "HAR-CORRUPT");
      } catch {
        rejected = true;
      }
      ensure(context, rejected, `${name} co-managed marker corruption was accepted`);
    }
  });

  testCase(context, "inverse_map_and_protocol_rank_are_deterministic", () => {
    const routing = protocol.loadRouting();
    const carrier = {
      artifact_id: "HAR-INVERSE",
      type: "markdown_document",
      path: "docs/runbooks/inverse.md",
      ownership: "managed",
      status: "active",
      source_kn_ids: ["KN-0001"],
      source_refs: [],
      content_hash: "sha256:" + "0".repeat(64),
      machine_segment_hash: "sha256:" + "0".repeat(64),
      human_segment_hash: null,
      outside_hash: "sha256:" + "0".repeat(64),
      proposal_id: null,
      candidate_path: null,
      generator_version: "test",
      last_verified: "2026-08-03",
      update_policy: "automatic",
    };
    const knowledge = {
      id: "KN-0001",
      lifecycle: "active",
      carrier_refs: ["HAR-INVERSE@docs/runbooks/inverse.md#" + routing.carrier_ref_suffixes.managed],
    };
    const valid = inverseMap.validateInverseMap({ knowledgeEntries: [knowledge], carriers: [carrier] });
    ensure(context, valid.ok && valid.findings.length === 0, "valid inverse map did not close deterministically");
    const broken = inverseMap.validateInverseMap({ knowledgeEntries: [{ ...knowledge, carrier_refs: [] }], carriers: [carrier] });
    ensure(context, !broken.ok && broken.findings.some((finding) => finding.issue === "inverse_missing_knowledge_ref"), "one-sided inverse reference was not an error");
    const ordered = compilePlan.sortPlanItems([
      { observation_id: "OBS-20260803-002", disposition: "no_change" },
      { observation_id: "OBS-20260803-001", disposition: "add" },
    ]);
    ensure(context, ordered[0].disposition === "add", "plan sort did not read protocol disposition_rank");
    ensure(context, Object.keys(routing.disposition_rank).length === routing.actions.length, "protocol rank coverage is incomplete");
  });

  testCase(context, "compile_v2_update_shape_reaches_preflight_without_mutation", () => {
    const setup = setupCompileCase(context, "v2-update-preflight", "publish-plan.json", "OBS-20260731-101");
    writeJson(setup.plan, {
      kind: "kg.compile_plan",
      version: 2,
      items: [
        {
          observation_id: "OBS-20260731-101",
          disposition: "update",
          actor: "compile",
          update_scope: "evidence_scope_refresh",
          body_action: "preserved",
          target_kn_id: "KN-0001",
          knowledge: {
            claim: "Compile-managed runbooks must preserve human text outside their managed block.",
            category: "project_knowledge",
            scope: { paths: ["docs/runbooks/**"] },
            authority: "verified_runtime_behavior",
            confidence: 1,
            body: "## Preserved\n\nThe human-authored body remains unchanged.",
          },
          carrier: {
            artifact_id: "HAR-COMPILE-NOTES",
            content: "The machine segment refresh is deferred to R4.2.",
          },
        },
      ],
    });
    const before = treeHash(setup.project);
    const rejected = applyCompile(context, setup, { expectFailure: true });
    ensure(context, rejected.stderr.includes("version 2 parsed successfully"), "v2 deferred preflight reason was not reported");
    ensure(context, treeHash(setup.project) === before, "v2 deferred update preflight changed host state");
  });

  testCase(context, "proposal_manifest_parser_recomputes_content_address_and_target_hash", () => {
    const caseRoot = path.join(context.root, "r41-proposal-manifest");
    const project = path.join(caseRoot, "project");
    fs.mkdirSync(path.join(project, ".kg"), { recursive: true });
    fs.mkdirSync(path.join(project, "docs", "proposals", "compile-test"), { recursive: true });
    const target = path.join(project, "docs", "runbook.md");
    const candidate = path.join(project, "docs", "proposals", "compile-test", "candidate.md");
    fs.writeFileSync(target, "human target\n");
    fs.writeFileSync(candidate, "proposal candidate\n");
    const hash = (file) => "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const manifest = {
      kind: "kg.carrier_proposal",
      version: 1,
      proposal_id: "compile-placeholder",
      carrier_type: "markdown_document",
      target_path: "docs/runbook.md",
      target_sha256: hash(target),
      candidate_path: "docs/proposals/compile-test/candidate.md",
      candidate_sha256: hash(candidate),
      source_kn_ids: ["KN-0001"],
      source_refs: ["docs/source.md#L1"],
      generator_version: "test",
      status: "proposed",
    };
    manifest.proposal_id = `compile-${proposal.proposalManifestDigest(manifest).slice(0, 16)}`;
    const manifestFile = path.join(caseRoot, "manifest.json");
    writeJson(manifestFile, manifest);
    const parsed = proposal.parseProposalManifest(manifestFile, { root: project });
    ensure(context, parsed.manifest.proposal_id === manifest.proposal_id, "proposal manifest identity was not recomputed");
    fs.appendFileSync(target, "drift\n");
    let rejected = false;
    try {
      proposal.parseProposalManifest(manifestFile, { root: project });
    } catch {
      rejected = true;
    }
    ensure(context, rejected, "proposal target drift was accepted");
    ensure(context, host.canonicalPath("/tmp") === host.canonicalPath("/private/tmp"), "path alias probe is unavailable");
  });

  testCase(context, "compile_links_observation_kn_and_managed_block", () => {
    const setup = setupCompileCase(
      context,
      "publish-positive",
      "publish-plan.json",
      "OBS-20260731-101",
    );
    const target = path.join(setup.project, "docs", "runbooks", "compile-notes.md");
    const sidecarFile = path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml");
    const targetBefore = fs.readFileSync(target, "utf8");
    const outsideBefore = outsideArtifactBlock(targetBefore, "HAR-COMPILE-NOTES");
    ensure(context, knowledgeFiles(setup.project).length === 1, "publish fixture did not start with one KN");
    ensure(
      context,
      listYaml(path.join(setup.project, ".kg", "observations")).length === 1,
      "publish fixture did not start with one pending observation",
    );
    const beforeChecks = treeHash(setup.project);
    runNode(
      context,
      COMPILE_CONTEXT,
      ["--root", setup.project, "--check", "--context", setup.context],
      { cwd: setup.project, env: { KG_ROOT: setup.project } },
    );
    runNode(
      context,
      COMPILE_APPLY,
      ["--check", "--root", setup.project, "--context", setup.context, "--plan", setup.plan],
      { cwd: setup.project, env: { KG_ROOT: setup.project } },
    );
    ensure(context, treeHash(setup.project) === beforeChecks, "compile/apply checks mutated the host");
    applyCompile(context, setup);

    const entries = knowledgeFiles(setup.project);
    ensure(context, entries.length === 2, "publish did not create exactly one KN");
    const newEntry = path.join(setup.project, "knowledge", entries.find((name) => name.startsWith("KN-0002")));
    const { frontmatter: knowledge, body } = readKnowledge(newEntry);
    ensure(context, knowledge.id === "KN-0002", "script-assigned KN id mismatch");
    ensure(context, knowledge.lifecycle === "active", "published KN is not active");
    ensure(context, knowledge.category === "project_knowledge", "published KN category mismatch");
    ensure(context, body.trim() !== "", "published KN body is empty");
    ensure(
      context,
      JSON.stringify(knowledge.source_obs_ids) === JSON.stringify(["OBS-20260731-101"]),
      "published KN source_obs_ids mismatch",
    );
    ensure(context, knowledge.carrier_refs.length === 1, "published KN carrier_refs must be unique");

    const pending = path.join(setup.project, ".kg", "observations", "OBS-20260731-101.yaml");
    const processed = path.join(setup.project, ".kg", "observations", "processed", "OBS-20260731-101.yaml");
    ensure(context, !fs.existsSync(pending), "publish left the observation pending");
    const processedRecord = readKyaml(processed);
    ensure(context, processedRecord.compiled_to_kn === "KN-0002", "processed observation KN link mismatch");

    const targetAfter = fs.readFileSync(target, "utf8");
    ensure(
      context,
      outsideArtifactBlock(targetAfter, "HAR-COMPILE-NOTES") === outsideBefore,
      "publish changed text outside the managed block",
    );
    ensure(context, targetAfter.includes("<!-- kg:source KN-0002 -->"), "managed block lacks a machine KN reference");
    const sidecar = readKyaml(sidecarFile);
    const block = harness.inspectManagedBlock(targetAfter, "HAR-COMPILE-NOTES");
    ensure(
      context,
      JSON.stringify(sidecar.source_kn_ids) === JSON.stringify(["KN-0002"]),
      "sidecar source_kn_ids mismatch",
    );
    ensure(context, sidecar.content_hash === block.contentHash, "sidecar hash does not match marker-inner content");
    ensure(context, sidecar.ownership === "managed", "sidecar ownership changed");
    ensure(context, sidecar.update_policy === "automatic", "sidecar update_policy changed");
    for (const ref of sidecar.source_refs) {
      const sourcePath = ref.replace(/#L[1-9][0-9]*$/, "");
      ensure(context, fs.existsSync(path.join(setup.project, sourcePath)), `sidecar source_ref is missing: ${ref}`);
    }
    ensure(
      context,
      knowledge.carrier_refs[0] ===
        `HAR-COMPILE-NOTES@docs/runbooks/compile-notes.md#kg:managed`,
      "KN carrier reference does not identify artifact, path, and managed block",
    );

    const reports = compileReports(setup.project);
    ensure(context, reports.length === 1, "publish did not create exactly one compile report");
    const report = readJson(path.join(setup.project, ".kg", "reports", reports[0]));
    ensure(context, report.results.publish_kn_and_carrier.length === 1, "publish report group mismatch");
    ensure(context, report.results.queue_only.length === 0 && report.results.no_change.length === 0, "publish report has cross-type results");
    ensure(context, report.known_limitations.length === 1, "D13 known limitation missing from machine report");
    ensure(
      context,
      JSON.stringify(report.archives[0].arguments) ===
        JSON.stringify(["--observation", "OBS-20260731-101", "--compiled-to-kn", "KN-0002"]),
      "publish report archive arguments mismatch",
    );

    const stable = treeHash(setup.project);
    applyCompile(context, setup);
    ensure(context, treeHash(setup.project) === stable, "same publish plan changed state on rerun");
    fs.appendFileSync(target, "\nHuman edit after completed compile.\n");
    ensure(
      context,
      harness.inspectManagedBlock(fs.readFileSync(target, "utf8"), "HAR-COMPILE-NOTES").contentHash ===
        sidecar.content_hash,
      "human text outside the marker changed the managed content hash",
    );
  });

  testCase(context, "compile_queue_only_preserves_queue_item", () => {
    const setup = setupCompileCase(
      context,
      "queue-positive",
      "queue-plan.json",
      "OBS-20260731-102",
    );
    const knowledgeBefore = treeHash(path.join(setup.project, "knowledge"));
    const carrierBefore = fileHash(path.join(setup.project, "docs", "runbooks", "compile-notes.md"));
    const sidecarBefore = fileHash(path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml"));
    applyCompile(context, setup);
    ensure(context, treeHash(path.join(setup.project, "knowledge")) === knowledgeBefore, "queue_only created a KN");
    ensure(context, fileHash(path.join(setup.project, "docs", "runbooks", "compile-notes.md")) === carrierBefore, "queue_only changed carrier");
    ensure(context, fileHash(path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml")) === sidecarBefore, "queue_only changed sidecar");
    const queueFiles = listYaml(path.join(setup.project, ".kg", "queue"));
    ensure(context, queueFiles.length === 1, "queue_only did not create exactly one queue item");
    const queue = readKyaml(path.join(setup.project, ".kg", "queue", queueFiles[0]));
    ensure(context, queue.category === "needs_human_decision", "queue_only category mismatch");
    ensure(
      context,
      JSON.stringify(queue.source_observations) === JSON.stringify(["OBS-20260731-102"]),
      "queue_only source_observations mismatch",
    );
    const processed = readKyaml(
      path.join(setup.project, ".kg", "observations", "processed", "OBS-20260731-102.yaml"),
    );
    ensure(context, processed.compiled_to_kn === undefined, "queue_only wrote compiled_to_kn");
    const report = readJson(path.join(setup.project, ".kg", "reports", compileReports(setup.project)[0]));
    ensure(context, report.results.queue_only.length === 1, "queue_only report group mismatch");
    ensure(
      context,
      JSON.stringify(report.archives[0].arguments) ===
        JSON.stringify(["--observation", "OBS-20260731-102", "--verdict", "needs_human_decision"]),
      "queue_only report archive arguments mismatch",
    );
  });

  testCase(context, "compile_no_change_preserves_state", () => {
    const setup = setupCompileCase(
      context,
      "no-change-positive",
      "no-change-plan.json",
      "OBS-20260731-103",
    );
    const knowledgeBefore = treeHash(path.join(setup.project, "knowledge"));
    const carrierBefore = fileHash(path.join(setup.project, "docs", "runbooks", "compile-notes.md"));
    const sidecarBefore = fileHash(path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml"));
    applyCompile(context, setup);
    ensure(context, treeHash(path.join(setup.project, "knowledge")) === knowledgeBefore, "no_change created a KN");
    ensure(context, listYaml(path.join(setup.project, ".kg", "queue")).length === 0, "no_change created a queue item");
    ensure(context, fileHash(path.join(setup.project, "docs", "runbooks", "compile-notes.md")) === carrierBefore, "no_change changed carrier");
    ensure(context, fileHash(path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml")) === sidecarBefore, "no_change changed sidecar");
    const processed = readKyaml(
      path.join(setup.project, ".kg", "observations", "processed", "OBS-20260731-103.yaml"),
    );
    ensure(context, processed.compiled_to_kn === undefined, "no_change wrote compiled_to_kn");
    const report = readJson(path.join(setup.project, ".kg", "reports", compileReports(setup.project)[0]));
    ensure(context, report.results.no_change.length === 1, "no_change report group mismatch");
    ensure(context, report.results.no_change[0].result_reason.includes("KN-0001"), "no_change audit reason missing");
  });

  testCase(context, "reject_unknown_kn_id_script_fields_and_cross_type_side_effects", () => {
    const variants = [
      ["unknown-top", (plan) => { plan.unexpected = true; }],
      ["self-kn-id", (plan) => { plan.items[0].knowledge.id = "KN-9999"; }],
      ["script-source-ids", (plan) => { plan.items[0].knowledge.source_obs_ids = ["OBS-20260731-101"]; }],
      ["script-carrier-path", (plan) => { plan.items[0].carrier.path = "docs/runbooks/compile-notes.md"; }],
      ["script-hash", (plan) => { plan.items[0].carrier.content_hash = "sha256:" + "0".repeat(64); }],
      ["queue-claims-kn-side-effect", (plan) => {
        plan.items[0] = {
          observation_id: "OBS-20260731-101",
          result_type: "queue_only",
          queue: {
            claim: "Queue this.",
            evidence: [{ type: "test", ref: "fixture" }],
            options: ["accept", "reject"],
            recommendation: "review",
          },
          knowledge: plan.items[0].knowledge,
        };
      }],
      ["no-change-claims-queue-side-effect", (plan) => {
        plan.items[0] = {
          observation_id: "OBS-20260731-101",
          result_type: "no_change",
          reason: "nothing",
          queue: {
            claim: "unexpected",
            evidence: [{ type: "test", ref: "fixture" }],
            options: ["accept", "reject"],
            recommendation: "review",
          },
        };
      }],
    ];
    for (const [name, mutate] of variants) {
      const setup = setupCompileCase(context, name, "publish-plan.json", "OBS-20260731-101");
      mutatePlan(setup, mutate);
      assertCompileFailurePreservesHost(context, setup);
    }
  });

  testCase(context, "preflight_kn_and_carrier_failures_leave_zero_partial_writes", () => {
    for (const point of ["kn_write", "carrier_write"]) {
      const setup = setupCompileCase(
        context,
        `preflight-${point}`,
        "publish-plan.json",
        "OBS-20260731-101",
      );
      const rejected = assertCompileFailurePreservesHost(context, setup, {
        env: { KG_COMPILE_FAIL_PREFLIGHT: point },
      });
      ensure(context, rejected.stderr.includes(`injected ${point === "kn_write" ? "KN" : "carrier"} write preflight failure`), `${point} injection reason missing`);
      ensure(context, compileReports(setup.project).length === 0, `${point} preflight failure created a report`);
      ensure(context, knowledgeFiles(setup.project).length === 1, `${point} preflight failure created a KN`);
    }
  });

  testCase(context, "reject_observation_document_and_sidecar_drift_after_plan", () => {
    const variants = {
      observation: (setup) =>
        fs.appendFileSync(
          path.join(setup.project, ".kg", "observations", "OBS-20260731-101.yaml"),
          "\n# changed after context\n",
        ),
      document: (setup) =>
        fs.appendFileSync(
          path.join(setup.project, "docs", "runbooks", "compile-notes.md"),
          "\nHuman edit after context.\n",
        ),
      sidecar: (setup) =>
        fs.appendFileSync(
          path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml"),
          "\n# changed after context\n",
        ),
    };
    for (const [name, mutate] of Object.entries(variants)) {
      const setup = setupCompileCase(context, `drift-${name}`, "publish-plan.json", "OBS-20260731-101");
      mutate(setup);
      const drifted = treeHash(setup.project);
      applyCompile(context, setup, { expectFailure: true });
      ensure(context, treeHash(setup.project) === drifted, `${name} drift failure changed host state`);
    }
  });

  testCase(context, "reject_non_managed_ownership_and_bad_markers", () => {
    for (const ownership of ["co_managed", "human"]) {
      const setupRoot = path.join(context.root, `ownership-${ownership}`);
      const project = path.join(setupRoot, "project");
      const artifacts = path.join(setupRoot, "artifacts");
      fs.cpSync(path.join(COMPILE_FIXTURE, "host"), project, { recursive: true });
      fs.mkdirSync(artifacts, { recursive: true });
      for (const file of fs.readdirSync(path.join(project, ".kg", "observations"))) {
        if (file.endsWith(".yaml") && file !== "OBS-20260731-101.yaml") {
          fs.rmSync(path.join(project, ".kg", "observations", file));
        }
      }
      const sidecar = path.join(project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml");
      fs.writeFileSync(sidecar, fs.readFileSync(sidecar, "utf8").replace("ownership: managed", `ownership: ${ownership}`));
      const setup = {
        project,
        artifacts,
        context: path.join(artifacts, "context.json"),
        plan: path.join(artifacts, "plan.json"),
      };
      fs.copyFileSync(path.join(COMPILE_FIXTURE, "publish-plan.json"), setup.plan);
      const before = treeHash(project);
      runNode(
        context,
        COMPILE_CONTEXT,
        ["--root", project, "--output", setup.context, "--now", "2026-07-31T02:00:00Z"],
        { cwd: project, env: { KG_ROOT: project }, expectFailure: true },
      );
      ensure(context, treeHash(project) === before, `${ownership} parser rejection changed host state`);
    }

    const markerVariants = {
      missing: (text) => text.replace("<!-- kg:managed HAR-COMPILE-NOTES begin -->\n", ""),
      duplicate: (text) =>
        text.replace(
          "<!-- kg:managed HAR-COMPILE-NOTES begin -->",
          "<!-- kg:managed HAR-COMPILE-NOTES begin -->\n<!-- kg:managed HAR-COMPILE-NOTES begin -->",
        ),
      mismatch: (text) => text.replaceAll("HAR-COMPILE-NOTES", "HAR-OTHER-NOTES"),
    };
    for (const [name, mutate] of Object.entries(markerVariants)) {
      const caseRoot = path.join(context.root, `marker-${name}`);
      const project = path.join(caseRoot, "project");
      const artifacts = path.join(caseRoot, "artifacts");
      fs.cpSync(path.join(COMPILE_FIXTURE, "host"), project, { recursive: true });
      fs.mkdirSync(artifacts, { recursive: true });
      const target = path.join(project, "docs", "runbooks", "compile-notes.md");
      fs.writeFileSync(target, mutate(fs.readFileSync(target, "utf8")));
      const before = treeHash(project);
      runNode(
        context,
        COMPILE_CONTEXT,
        ["--root", project, "--output", path.join(artifacts, "context.json"), "--now", "2026-07-31T02:00:00Z"],
        { cwd: project, env: { KG_ROOT: project }, expectFailure: true },
      );
      ensure(context, treeHash(project) === before, `${name} marker rejection changed host state`);
    }
  });

  testCase(context, "transaction_manifest_resumes_after_mutation_interruptions", () => {
    for (const point of ["kn_write", "carrier_write"]) {
      const setup = setupCompileCase(
        context,
        `resume-${point}`,
        "publish-plan.json",
        "OBS-20260731-101",
      );
      const interrupted = applyCompile(context, setup, {
        expectFailure: true,
        env: { KG_COMPILE_FAIL_AFTER: point },
      });
      ensure(context, interrupted.stderr.includes(`injected failure after ${point === "kn_write" ? "KN" : "carrier"} write`), `${point} interruption did not trigger`);
      ensure(
        context,
        fs.readdirSync(path.join(setup.project, ".kg", "reports")).some((name) => name.startsWith(".compile-transaction-")),
        `${point} interruption did not preserve a transaction manifest`,
      );
      applyCompile(context, setup);
      ensure(context, compileReports(setup.project).length === 1, `${point} resume did not complete the report`);
      ensure(context, knowledgeFiles(setup.project).length === 2, `${point} resume duplicated or lost the KN`);
      const stable = treeHash(setup.project);
      applyCompile(context, setup);
      ensure(context, treeHash(setup.project) === stable, `${point} completed resume is not idempotent`);
    }
  });

  testCase(context, "gd_evaluator_requires_reads_non_shell_plan_apply_and_no_denials", () => {
    const fixture = path.join(ROOT, "scripts", "fixtures", "m2", "compile.fixture.json");
    const passing = path.join(context.root, "gd-pass");
    runNode(context, EVAL_COMPILE, ["--fixture", fixture, "--artifacts", passing], {
      cwd: ROOT,
      env: { KG_EVAL_RUNNER: MOCK_COMPILE_RUNNER },
    });
    ensure(context, readJson(path.join(passing, "result.json")).pass === true, "G-D mock session did not pass");
    const prompt = fs.readFileSync(path.join(passing, "actual-prompt.txt"), "utf8");
    ensure(
      context,
      !prompt.includes("OBS-20260731-101") && !prompt.includes("KN-0001 already"),
      "G-D fixture oracle leaked into the runner prompt",
    );

    const switches = {
      shell: "KG_FAKE_SHELL_PLAN",
      missing_tool: "KG_FAKE_MISSING_TOOL",
      missing_read: "KG_FAKE_MISSING_READ",
      denial: "KG_FAKE_DENIAL",
      wrong_order: "KG_FAKE_WRONG_ORDER",
    };
    for (const [name, variable] of Object.entries(switches)) {
      const artifacts = path.join(context.root, `gd-${name}`);
      runNode(context, EVAL_COMPILE, ["--fixture", fixture, "--artifacts", artifacts], {
        cwd: ROOT,
        env: { KG_EVAL_RUNNER: MOCK_COMPILE_RUNNER, [variable]: "1" },
        expectFailure: true,
      });
      ensure(context, readJson(path.join(artifacts, "result.json")).pass === false, `G-D ${name} regression passed`);
    }

    // D38: a failed exploratory read (ENOENT probe) is evidence, not a verdict.
    // The gate must still pass and surface the event as a warning.
    const exploration = path.join(context.root, "gd-failed-exploration");
    runNode(context, EVAL_COMPILE, ["--fixture", fixture, "--artifacts", exploration], {
      cwd: ROOT,
      env: { KG_EVAL_RUNNER: MOCK_COMPILE_RUNNER, KG_FAKE_FAILED_EXPLORATION: "1" },
    });
    const explorationResult = readJson(path.join(exploration, "result.json"));
    ensure(context, explorationResult.pass === true, "failed exploratory read must not fail the gate");
    ensure(
      context,
      Array.isArray(explorationResult.warnings) &&
        explorationResult.warnings.some((warning) => warning.includes("routing.yaml")),
      "failed exploratory read was not surfaced as a warning",
    );

    // Reads that happen before the compile context step still count: only
    // "read after plan submission" breaks the chain proof.
    const earlyRead = path.join(context.root, "gd-early-read");
    runNode(context, EVAL_COMPILE, ["--fixture", fixture, "--artifacts", earlyRead], {
      cwd: ROOT,
      env: { KG_EVAL_RUNNER: MOCK_COMPILE_RUNNER, KG_FAKE_EARLY_READ: "1" },
    });
    ensure(
      context,
      readJson(path.join(earlyRead, "result.json")).pass === true,
      "input read before compile context must not fail the gate",
    );
  });
}

function runPart5(context) {
  testCase(context, "fixture_lint_rejects_all_out_of_range_anchors", () => {
    runNode(context, FIXTURE_LINT, [], { cwd: ROOT });
    const fixtureRoot = path.join(context.root, "fixture-lint-negative");
    const project = path.join(fixtureRoot, "project");
    fs.mkdirSync(path.join(project, "docs"), { recursive: true });
    fs.mkdirSync(path.join(project, "harness"), { recursive: true });
    fs.writeFileSync(path.join(project, "docs", "source.md"), "one line\n");
    fs.writeFileSync(path.join(project, "harness", "artifact.json"), '{"source_ref":"docs/source.md#L2"}\n');
    fs.writeFileSync(path.join(project, "harness", "range.json"), '{"source_ref":"docs/source.md#L1-L2"}\n');
    writeJson(path.join(fixtureRoot, "compile.fixture.json"), {
      kind: "kg.eval_compile_fixture",
      version: 1,
      project_source: project,
      task: "reject out of range fixture anchors",
    });
    const rejected = runNode(context, FIXTURE_LINT, ["--root", fixtureRoot], {
      cwd: ROOT,
      expectFailure: true,
    });
    ensure(context, rejected.stderr.includes("docs/source.md#L2"), "fixture lint did not name the rejected anchor");
    ensure(context, rejected.stderr.includes("docs/source.md#L1-L2"), "fixture lint did not reject the range end");
    ensure(context, rejected.stderr.includes("line"), "fixture lint did not report the line-bound failure");
  });

  function runKickoffGate(name, fixture, env = {}, expectFailure = false) {
    const artifacts = path.join(context.root, name);
    runNode(context, EVAL_KICKOFF, ["--fixture", fixture, "--artifacts", artifacts], {
      cwd: ROOT,
      env: { KG_EVAL_RUNNER: MOCK_KICKOFF_RUNNER, ...env },
      expectFailure,
    });
    return {
      artifacts,
      result: readJson(path.join(artifacts, "result.json")),
    };
  }

  testCase(context, "compiled_fixture_matches_real_m2d_apply_output", () => {
    const setup = setupCompileCase(
      context,
      "kickoff-compiled-source",
      "publish-plan.json",
      "OBS-20260731-101",
    );
    applyCompile(context, setup);
    const generatedKn = path.join(
      setup.project,
      "knowledge",
      knowledgeFiles(setup.project).find((name) => name.startsWith("KN-0002-")),
    );
    const landedKn = path.join(
      KICKOFF_COMPILED_PROJECT,
      "knowledge",
      "KN-0002-compile-managed-runbooks-must-preserve-human.md",
    );
    ensure(
      context,
      fs.readFileSync(generatedKn, "utf8") === fs.readFileSync(landedKn, "utf8"),
      "third kickoff fixture KN differs from real M2D apply output",
    );
    ensure(
      context,
      fs.readFileSync(path.join(setup.project, "docs", "runbooks", "compile-notes.md"), "utf8") ===
        fs.readFileSync(path.join(KICKOFF_COMPILED_PROJECT, "docs", "runbooks", "compile-notes.md"), "utf8"),
      "third kickoff fixture carrier differs from real M2D apply output",
    );
    ensure(
      context,
      fs.readFileSync(
        path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml"),
        "utf8",
      ) ===
        fs.readFileSync(
          path.join(KICKOFF_COMPILED_PROJECT, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml"),
          "utf8",
        ),
      "third kickoff fixture sidecar differs from real M2D apply output",
    );
  });

  testCase(context, "record_turn_rejects_agent_envelope_fields_and_validates_semantics", () => {
    const caseRoot = path.join(context.root, "record-turn");
    fs.mkdirSync(caseRoot, { recursive: true });
    const projectRoot = path.join(ROOT, "scripts", "fixtures", "m1", "project");
    const kickoffIndex = path.join(caseRoot, "kickoff-index.json");
    runNode(
      context,
      GATHER_KICKOFF_CONTEXT,
      [
        "--root",
        projectRoot,
        "--task",
        "为 Payment 到 Order 的写入增加重试",
        "--phase",
        "index",
        "--output",
        kickoffIndex,
      ],
      { cwd: ROOT },
    );
    const transcript = path.join(caseRoot, "transcript.json");
    const question = "你希望采用事件发布重试吗？";
    writeJson(transcript, {
      transcript: [
        { role: "user", content: "为 Payment 到 Order 的写入增加重试" },
        { role: "assistant", content: `我推荐事件发布。理由：保留已接受边界。${question}` },
      ],
    });
    const validInput = {
      findings: [
        {
          source_path: "docs/decisions/0001-payment-order-event-bus.md",
          line: 15,
          status: "accepted",
          authority: "formal_decision",
        },
      ],
      question: {
        question_text: question,
        assistant_message_index: 1,
      },
    };
    const input = path.join(caseRoot, "input.json");
    const output = path.join(caseRoot, "turn.yaml");
    writeJson(input, validInput);
    runNode(
      context,
      RECORD_KICKOFF_TURN,
      [
        "--project-root",
        projectRoot,
        "--index",
        kickoffIndex,
        "--input",
        input,
        "--transcript",
        transcript,
        "--output",
        output,
        "--now",
        "2026-07-31T05:00:00Z",
      ],
      { cwd: ROOT },
    );
    const record = readKyaml(output);
    ensure(context, record.kind === "kg.kickoff_turn" && record.version === 1, "turn envelope was not injected");
    ensure(context, record.recorded_at === "2026-07-31T05:00:00.000Z", "turn timestamp was not injected");
    ensure(context, typeof record.session_id === "string" && record.session_id.length > 0, "turn session_id missing");
    const text = fs.readFileSync(output, "utf8");
    const canonicalKeys = ["kind:", "version:", "recorded_at:", "session_id:", "findings:", "question:"];
    ensure(
      context,
      canonicalKeys.every(
        (key, index) => index === 0 || text.indexOf(canonicalKeys[index - 1]) < text.indexOf(key),
      ),
      "turn KYAML keys are not canonical",
    );

    const variants = [
      ["script-field", { ...validInput, kind: "kg.kickoff_turn" }],
      [
        "bad-status",
        {
          ...validInput,
          findings: [{ ...validInput.findings[0], status: "draft" }],
        },
      ],
      [
        "implementation-path",
        {
          ...validInput,
          findings: [
            {
              source_path: "scripts/eval-kickoff.mjs",
              line: 1,
              status: "unregistered",
              authority: "reference_only",
            },
          ],
        },
      ],
      [
        "bad-index",
        {
          ...validInput,
          question: { ...validInput.question, assistant_message_index: 0 },
        },
      ],
      [
        "duplicate-question",
        {
          ...validInput,
          question: { ...validInput.question, question_text: "事件" },
        },
      ],
      [
        "duplicate-finding",
        {
          ...validInput,
          findings: [validInput.findings[0], { ...validInput.findings[0] }],
        },
      ],
      [
        "finding-outside-index",
        {
          ...validInput,
          findings: [
            {
              source_path: "docs/unrelated/marketing.md",
              line: 1,
              status: "unregistered",
              authority: "reference_only",
            },
          ],
        },
      ],
    ];
    for (const [name, value] of variants) {
      const badInput = path.join(caseRoot, `${name}.json`);
      const badOutput = path.join(caseRoot, `${name}.yaml`);
      writeJson(badInput, value);
      runNode(
        context,
        RECORD_KICKOFF_TURN,
        [
          "--project-root",
          projectRoot,
          "--index",
          kickoffIndex,
          "--input",
          badInput,
          "--transcript",
          transcript,
          "--output",
          badOutput,
          "--now",
          "2026-07-31T05:00:00Z",
        ],
        { cwd: ROOT, expectFailure: true },
      );
      ensure(context, !fs.existsSync(badOutput), `${name} rejection wrote a turn product`);
    }

    for (const [name, mutation] of [
      ["bad-kind", (index) => { index.kind = "kg.tampered"; }],
      ["bad-version", (index) => { index.version = 99; }],
      ["bad-entries", (index) => { index.entries = {}; }],
    ]) {
      const invalidIndex = path.join(caseRoot, `${name}-index.json`);
      const index = readJson(kickoffIndex);
      mutation(index);
      writeJson(invalidIndex, index);
      const badOutput = path.join(caseRoot, `${name}-index-turn.yaml`);
      runNode(
        context,
        RECORD_KICKOFF_TURN,
        [
          "--project-root",
          projectRoot,
          "--index",
          invalidIndex,
          "--input",
          input,
          "--transcript",
          transcript,
          "--output",
          badOutput,
        ],
        { cwd: ROOT, expectFailure: true },
      );
      ensure(context, !fs.existsSync(badOutput), `${name} index rejection wrote a turn product`);
    }

    const missingIndexOutput = path.join(caseRoot, "missing-index.yaml");
    runNode(
      context,
      RECORD_KICKOFF_TURN,
      [
        "--project-root",
        projectRoot,
        "--input",
        input,
        "--transcript",
        transcript,
        "--output",
        missingIndexOutput,
      ],
      { cwd: ROOT, expectFailure: true },
    );
    ensure(context, !fs.existsSync(missingIndexOutput), "missing --index wrote a turn product");
  });

  testCase(context, "sidecar_source_refs_enter_index_and_support_findings", () => {
    const caseRoot = path.join(context.root, "source-ref-positive");
    const project = path.join(caseRoot, "project");
    fs.cpSync(KICKOFF_COMPILED_PROJECT, project, { recursive: true });
    const indexFile = path.join(caseRoot, "kickoff-index.json");
    const contextFile = path.join(caseRoot, "kickoff-context.json");
    const transcriptFile = path.join(caseRoot, "transcript.json");
    const inputFile = path.join(caseRoot, "turn-input.json");
    const turnFile = path.join(caseRoot, "turn.yaml");
    const sourcePath = "docs/accepted-compile-contract.md";
    runNode(
      context,
      GATHER_KICKOFF_CONTEXT,
      [
        "--root",
        project,
        "--task",
        "验证 accepted compile contract",
        "--phase",
        "index",
        "--output",
        indexFile,
      ],
      { cwd: ROOT },
    );
    const index = readJson(indexFile);
    const entry = index.entries.find((item) => item.path === sourcePath);
    ensure(context, entry?.status === "accepted", "source_ref target did not retain accepted status");
    ensure(context, entry?.authority === "formal_decision", "source_ref target authority mapping is wrong");
    runNode(
      context,
      GATHER_KICKOFF_CONTEXT,
      [
        "--root",
        project,
        "--phase",
        "deep",
        "--index",
        indexFile,
        "--include",
        sourcePath,
        "--output",
        contextFile,
      ],
      { cwd: ROOT },
    );
    const deep = readJson(contextFile);
    ensure(context, deep.documents.some((item) => item.path === sourcePath), "source_ref target could not be deep-read");
    const question = "你希望保留 accepted route target 吗？";
    writeJson(transcriptFile, {
      transcript: [
        { role: "user", content: "验证 accepted compile contract" },
        { role: "assistant", content: `我推荐保留。理由：这是 accepted contract。${question}` },
      ],
    });
    writeJson(inputFile, {
      findings: [
        {
          source_path: sourcePath,
          line: 14,
          status: "accepted",
          authority: "formal_decision",
        },
      ],
      question: {
        question_text: question,
        assistant_message_index: 1,
      },
    });
    runNode(
      context,
      RECORD_KICKOFF_TURN,
      [
        "--project-root",
        project,
        "--index",
        indexFile,
        "--input",
        inputFile,
        "--transcript",
        transcriptFile,
        "--output",
        turnFile,
        "--now",
        "2026-07-31T05:00:00Z",
      ],
      { cwd: ROOT },
    );
    ensure(
      context,
      readKyaml(turnFile).findings[0].source_path === sourcePath,
      "source_ref target finding was not recorded",
    );
  });

  testCase(context, "missing_sidecar_source_ref_is_reported_without_hallucinated_entry", () => {
    const caseRoot = path.join(context.root, "source-ref-missing");
    const project = path.join(caseRoot, "project");
    fs.cpSync(KICKOFF_COMPILED_PROJECT, project, { recursive: true });
    const sidecarFile = path.join(project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml");
    const missingRef = "docs/missing-accepted-contract.md#L15";
    const sidecar = readKyaml(sidecarFile);
    sidecar.source_refs = [missingRef];
    fs.writeFileSync(sidecarFile, harness.renderHarnessSidecar(sidecar));
    const indexFile = path.join(caseRoot, "kickoff-index.json");
    runNode(
      context,
      GATHER_KICKOFF_CONTEXT,
      [
        "--root",
        project,
        "--task",
        "验证缺失 source_ref 降级",
        "--phase",
        "index",
        "--output",
        indexFile,
      ],
      { cwd: ROOT },
    );
    const index = readJson(indexFile);
    const harnessEntry = index.harness.find((item) => item.artifact_id === "HAR-COMPILE-NOTES");
    ensure(context, harnessEntry?.status === "active", "missing source_ref invalidated the legal sidecar");
    ensure(
      context,
      harnessEntry.source_ref_issues?.some((issue) => issue.source_ref === missingRef),
      "missing source_ref issue was not recorded on the harness entry",
    );
    ensure(
      context,
      !index.entries.some((entry) => entry.path === "docs/missing-accepted-contract.md"),
      "missing source_ref produced a hallucinated index entry",
    );
  });

  testCase(context, "three_saved_fixtures_pass_structured_checks", () => {
    for (const fixture of KICKOFF_FIXTURES) {
      runNode(context, EVAL_KICKOFF, ["--check-fixture", fixture], { cwd: ROOT });
    }
  });

  testCase(context, "three_mock_sessions_pass_without_oracle_prompt_leakage", () => {
    for (const [index, fixture] of KICKOFF_FIXTURES.entries()) {
      const run = runKickoffGate(`mock-positive-${index + 1}`, fixture);
      ensure(context, run.result.pass === true, `mock fixture ${index + 1} did not pass`);
      const fixtureRecord = readKyaml(fixture);
      const prompt = fs.readFileSync(path.join(run.artifacts, "actual-prompt.txt"), "utf8");
      for (const secret of [
        ...fixtureRecord.must_find,
        ...fixtureRecord.must_report,
        ...fixtureRecord.distractors,
      ]) {
        ensure(context, !prompt.includes(secret), `fixture oracle leaked into prompt: ${secret}`);
      }
      for (const directive of [
        "--index",
        "逐字节恰好出现一次",
        "markdown 反引号",
        "加粗",
        "引号替换",
        "英文双引号必须用反斜杠转义",
        "「」",
      ]) {
        ensure(context, prompt.includes(directive), `kickoff prompt lacks hardening directive: ${directive}`);
      }
    }
  });

  testCase(context, "structured_negative_cases_fail_the_target_criteria", () => {
    const compiledFixture = KICKOFF_FIXTURES[2];
    const proseOnly = runKickoffGate(
      "negative-prose-only",
      compiledFixture,
      { KG_FAKE_PROSE_ONLY: "1" },
      true,
    );
    ensure(context, proseOnly.result.must_find.pass === false, "prose-only KN mention passed must_find");

    for (const role of ["analysis", "tool", "out_of_range"]) {
      const badIndex = runKickoffGate(
        `negative-question-${role}`,
        compiledFixture,
        { KG_FAKE_BAD_QUESTION_INDEX: role },
        true,
      );
      ensure(context, badIndex.result.must_ask.pass === false, `${role} question pointer passed must_ask`);
    }

    const uncoveredConflict = runKickoffGate(
      "negative-uncovered-conflict",
      compiledFixture,
      { KG_FAKE_CONFLICT_NOT_COVERED: "1" },
      true,
    );
    ensure(
      context,
      uncoveredConflict.result.must_ask.pass === false,
      "question turn without the recorded conflict source passed must_ask",
    );

    const unreadReason = runKickoffGate(
      "negative-unread-reason",
      compiledFixture,
      { KG_FAKE_UNREAD_REASON: "1" },
      true,
    );
    ensure(
      context,
      unreadReason.result.forbid_fabrication.pass === false,
      "finding used as an unread reason source passed forbid_fabrication",
    );

    const readDistractor = runKickoffGate(
      "negative-read-distractor",
      compiledFixture,
      { KG_FAKE_READ_DISTRACTOR: "1" },
      true,
    );
    ensure(
      context,
      readDistractor.result.forbid_fabrication.pass === false &&
        readDistractor.result.file_read_policy.pass === false,
      "deep-read distractor passed the structural read policy",
    );

    for (const source of ["kn", "carrier"]) {
      const singleSource = runKickoffGate(
        `negative-single-${source}`,
        compiledFixture,
        { KG_FAKE_SINGLE_SOURCE: source },
        true,
      );
      ensure(context, singleSource.result.must_find.pass === false, `single ${source} source passed dual-source closure`);
    }

    const unexpectedConflict = runKickoffGate(
      "negative-no-conflict-product",
      KICKOFF_FIXTURES[1],
      { KG_FAKE_NONEMPTY_CONFLICT: "1" },
      true,
    );
    ensure(
      context,
      unexpectedConflict.result.must_report.pass === false,
      "non-empty conflict product passed the no-conflict fixture",
    );
  });

  testCase(context, "failed_exploration_warns_and_early_reads_remain_valid", () => {
    const failedExploration = runKickoffGate(
      "regression-failed-exploration",
      KICKOFF_FIXTURES[2],
      { KG_FAKE_FAILED_EXPLORATION: "1" },
    );
    ensure(context, failedExploration.result.pass === true, "failed exploratory read invalidated kickoff");
    ensure(
      context,
      failedExploration.result.warnings.some((warning) => warning.includes("missing-exploration.md")),
      "failed exploratory read warning was not retained",
    );

    const earlyRead = runKickoffGate(
      "regression-early-read",
      KICKOFF_FIXTURES[2],
      { KG_FAKE_EARLY_READ: "1" },
    );
    ensure(context, earlyRead.result.pass === true, "early source reads invalidated kickoff");

    // D48: recorder-vs-recorder ordering has no integrity function; only
    // "conflict recorder after deep" is an invariant.
    const lateConflict = runKickoffGate(
      "regression-late-conflict",
      KICKOFF_FIXTURES[2],
      { KG_FAKE_LATE_CONFLICT: "1" },
    );
    ensure(
      context,
      lateConflict.result.pass === true,
      "conflict recorder running after turn recorder invalidated kickoff",
    );
  });
}

function fixturePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function setupSpecArchiveCase(context, name, fixtureIndex = 2) {
  const record = readKyaml(SPEC_FIXTURES[fixtureIndex]);
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.cpSync(fixturePath(record.project_root), project, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const packet = path.join(artifacts, "spec-packet.json");
  runNode(
    context,
    SPEC_PRODUCE,
    [
      "--prepare",
      "--project-root",
      project,
      "--transcript",
      fixturePath(record.kickoff_response),
      "--kickoff-artifacts",
      fixturePath(record.kickoff_artifacts_root),
      "--output",
      packet,
    ],
    { cwd: project },
  );
  return {
    record,
    caseRoot,
    project,
    artifacts,
    packet,
    synthesis: fixturePath(record.spec_artifacts_root + "/spec-synthesis.json"),
  };
}

function archiveSpec(context, setup, synthesis = setup.synthesis, options = {}) {
  const run = runNode(
    context,
    SPEC_PRODUCE,
    [
      "--archive",
      "--project-root",
      setup.project,
      "--packet",
      setup.packet,
      "--synthesis",
      synthesis,
      "--now",
      "2026-07-31T08:00:00Z",
    ],
    { cwd: setup.project, expectFailure: options.expectFailure },
  );
  return options.expectFailure ? run : JSON.parse(run.stdout);
}

function writeFixtureFile(file, value) {
  fs.writeFileSync(file, kyaml.stringify(value));
}

function runMutatedSpecFixture(context, name, mutate, options = {}) {
  const base = readKyaml(SPEC_FIXTURES[options.fixtureIndex ?? 0]);
  const caseRoot = path.join(context.root, name);
  const specArtifacts = path.join(caseRoot, "spec-artifacts");
  const responseFile = path.join(specArtifacts, "runner-response.json");
  let projectRoot = fixturePath(base.project_root);
  fs.mkdirSync(caseRoot, { recursive: true });
  if (options.copyProject === true) {
    projectRoot = path.join(caseRoot, "project");
    fs.cpSync(fixturePath(base.project_root), projectRoot, { recursive: true });
  }
  fs.cpSync(fixturePath(base.spec_artifacts_root), specArtifacts, { recursive: true });
  const response = readJson(responseFile);
  mutate({ response, specArtifacts, caseRoot, fixture: base, projectRoot });
  writeJson(responseFile, response);
  const fixture = {
    ...base,
    project_root: projectRoot,
    kickoff_response: fixturePath(base.kickoff_response),
    kickoff_artifacts_root: fixturePath(base.kickoff_artifacts_root),
    spec_response: responseFile,
    spec_artifacts_root: specArtifacts,
  };
  if (options.kickoffResponse) fixture.kickoff_response = options.kickoffResponse;
  const fixtureFile = path.join(caseRoot, "fixture.yaml");
  writeFixtureFile(fixtureFile, fixture);
  return runNode(context, EVAL_SPEC, ["--check-fixture", fixtureFile], {
    cwd: ROOT,
    expectFailure: options.expectFailure === true,
  });
}

function runPart6(context) {
  testCase(context, "spec_archives_compiled_context_transcript", () => {
    const setup = setupSpecArchiveCase(context, "archive-positive");
    const specsDir = path.join(setup.project, "docs", "specs");
    ensure(context, !fs.existsSync(specsDir), "archive fixture started with docs/specs");
    const first = archiveSpec(context, setup);
    ensure(context, first.task_id === "TASK-20260731-001", "first same-day task id is not 001");
    ensure(context, first.created_at === "2026-07-31T08:00:00.000Z", "archive did not use the fixed clock");
    ensure(context, first.status === "draft", "archive did not assign draft status");
    const firstFile = path.join(setup.project, ...first.path.split("/"));
    const firstHash = fileHash(firstFile);
    runNode(context, SPEC_PRODUCE, ["--check", firstFile, "--project-root", setup.project], {
      cwd: setup.project,
    });
    const second = archiveSpec(context, setup);
    ensure(context, second.task_id === "TASK-20260731-002", "second same-day task id is not 002");
    ensure(context, fileHash(firstFile) === firstHash, "second archive overwrote the first archive");
    const secondFile = path.join(setup.project, ...second.path.split("/"));
    const secondText = fs.readFileSync(secondFile, "utf8");
    const secondFrontmatter = protocol.splitFrontmatter(secondText).frontmatter;
    ensure(context, secondFrontmatter.status === "draft", "archived task status is not draft");
    ensure(
      context,
      secondText.includes("knowledge/KN-0002-compile-managed-runbooks-must-preserve-human.md#L3"),
      "compiled active KN constraint is missing",
    );
    ensure(
      context,
      secondText.includes("docs/runbooks/compile-notes.md#L3"),
      "compiled managed document constraint is missing",
    );
    ensure(
      context,
      secondText.includes(setup.record.expected_kickoff_session_id) &&
        secondText.includes(setup.record.expected_turn_session_id),
      "Session History does not bind the kickoff sessions",
    );
    for (const section of setup.record.required_sections.split("|")) {
      ensure(context, countHeading(secondText, section) === 1, `archive section ${section} is not unique`);
    }
  });

  testCase(context, "archive_rejects_script_owned_agent_fields", () => {
    const variants = [
      ["task-id", (raw) => { raw.task.task_id = "TASK-20260731-777"; }],
      ["created-at", (raw) => { raw.created_at = "2026-07-31T00:00:00Z"; }],
      ["absolute-output", (raw) => { raw.output = "/tmp/agent-selected.md"; }],
      ["sequence", (raw) => { raw.sequence = 9; }],
    ];
    for (const [name, mutate] of variants) {
      const setup = setupSpecArchiveCase(context, `owned-${name}`);
      const synthesis = path.join(setup.artifacts, `${name}.json`);
      const raw = readJson(setup.synthesis);
      mutate(raw);
      writeJson(synthesis, raw);
      archiveSpec(context, setup, synthesis, { expectFailure: true });
      ensure(
        context,
        !fs.existsSync(path.join(setup.project, "docs", "specs")) ||
          fs.readdirSync(path.join(setup.project, "docs", "specs")).length === 0,
        `${name} rejection wrote an archive`,
      );
    }
    const nonJson = setupSpecArchiveCase(context, "owned-non-json");
    const yamlSynthesis = path.join(nonJson.artifacts, "synthesis.yaml");
    fs.writeFileSync(yamlSynthesis, "kind: kg.spec_synthesis\nversion: 2\n");
    archiveSpec(context, nonJson, yamlSynthesis, { expectFailure: true });
  });

  testCase(context, "archive_rejects_unstable_source_anchors", () => {
    const variants = [
      ["implementation", "scripts/eval-spec.mjs#L1"],
      ["missing", "docs/missing-constraint.md#L1"],
      ["out-of-range", "docs/accepted-compile-contract.md#L999"],
      ["kg-case", ".KG/uncompiled.md#L1"],
      ["escape", "docs/../accepted-compile-contract.md#L1"],
    ];
    for (const [name, sourcePath] of variants) {
      const setup = setupSpecArchiveCase(context, `anchor-${name}`);
      const synthesis = path.join(setup.artifacts, `${name}.json`);
      const raw = readJson(setup.synthesis);
      raw.constraints[0].source_path = sourcePath;
      writeJson(synthesis, raw);
      archiveSpec(context, setup, synthesis, { expectFailure: true });
    }

    const symlink = setupSpecArchiveCase(context, "anchor-symlink");
    fs.symlinkSync(
      path.join(symlink.project, "docs", "accepted-compile-contract.md"),
      path.join(symlink.project, "docs", "linked-contract.md"),
    );
    const linkedSynthesis = path.join(symlink.artifacts, "symlink.json");
    const linkedRaw = readJson(symlink.synthesis);
    linkedRaw.constraints[0].source_path = "docs/linked-contract.md#L14";
    writeJson(linkedSynthesis, linkedRaw);
    archiveSpec(context, symlink, linkedSynthesis, { expectFailure: true });
  });

  testCase(context, "archive_rejects_conflict_omission_and_metadata_lies", () => {
    const conflict = setupSpecArchiveCase(context, "conflict-omitted", 0);
    const conflictSynthesis = path.join(conflict.artifacts, "conflict-omitted.json");
    const conflictRaw = readJson(conflict.synthesis);
    conflictRaw.out_of_scope = [
      {
        statement: "A generic scope item without conflict linkage.",
        conflict_source_path: null,
      },
    ];
    writeJson(conflictSynthesis, conflictRaw);
    archiveSpec(context, conflict, conflictSynthesis, { expectFailure: true });

    const metadata = setupSpecArchiveCase(context, "metadata-lie");
    const metadataSynthesis = path.join(metadata.artifacts, "metadata-lie.json");
    const metadataRaw = readJson(metadata.synthesis);
    metadataRaw.constraints[0].source_status = "draft";
    writeJson(metadataSynthesis, metadataRaw);
    archiveSpec(context, metadata, metadataSynthesis, { expectFailure: true });
  });

  testCase(context, "existing_archive_targets_are_never_overwritten", () => {
    const setup = setupSpecArchiveCase(context, "existing-target");
    const specs = path.join(setup.project, "docs", "specs");
    fs.mkdirSync(specs, { recursive: true });
    const sentinel = path.join(specs, "TASK-20260731-001.md");
    fs.writeFileSync(sentinel, "sentinel archive\n");
    const sentinelHash = fileHash(sentinel);
    const result = archiveSpec(context, setup);
    ensure(context, result.task_id === "TASK-20260731-002", "archive did not allocate around an existing target");
    ensure(context, fileHash(sentinel) === sentinelHash, "archive overwrote an existing target");

    const exhausted = setupSpecArchiveCase(context, "existing-target-exhausted");
    const exhaustedSpecs = path.join(exhausted.project, "docs", "specs");
    fs.mkdirSync(exhaustedSpecs, { recursive: true });
    const last = path.join(exhaustedSpecs, "TASK-20260731-999.md");
    fs.writeFileSync(last, "last sentinel\n");
    const lastHash = fileHash(last);
    archiveSpec(context, exhausted, exhausted.synthesis, { expectFailure: true });
    ensure(context, fileHash(last) === lastHash, "exhausted id rejection changed an existing archive");
  });

  testCase(context, "spec_evaluator_rejects_questions_denials_and_unsafe_products", () => {
    runMutatedSpecFixture(context, "spec-task-path-is-not-a-question", ({ response }) => {
      response.tool_events.push({
        name: "Read",
        command: "Read protocol/task-spec.schema.yaml and docs/specs/TASK-20260731-001.md",
        at_step: 3,
        ok: true,
      });
    });
    runMutatedSpecFixture(
      context,
      "spec-question-mark",
      ({ response }) => {
        response.transcript[1].content = "Should I ask the user?";
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-request-user-input",
      ({ response }) => {
        response.transcript[1].tool_calls = [{ name: "request_user_input" }];
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-request-user-input-event",
      ({ response }) => {
        response.tool_events.push({
          name: "request_user_input",
          command: "request_user_input",
          at_step: 3,
          ok: true,
        });
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-ask-user-question-event",
      ({ response }) => {
        response.tool_events.push({
          name: "AskUserQuestion",
          command: "Ask whether the synthesis should continue",
          at_step: 3,
          ok: true,
        });
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-permission-denial",
      ({ response }) => {
        response.permission_denials = [{ tool: "Write", at_step: 2, detail: "denied" }];
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-product-escape",
      ({ response, caseRoot }) => {
        const outside = path.join(caseRoot, "outside.json");
        fs.copyFileSync(
          path.join(caseRoot, "spec-artifacts", "spec-synthesis.json"),
          outside,
        );
        response.products[0].path = "../outside.json";
      },
      { expectFailure: true },
    );
    runMutatedSpecFixture(
      context,
      "spec-product-symlink",
      ({ specArtifacts, caseRoot }) => {
        const synthesis = path.join(specArtifacts, "spec-synthesis.json");
        const target = path.join(caseRoot, "real-synthesis.json");
        fs.copyFileSync(synthesis, target);
        fs.rmSync(synthesis);
        fs.symlinkSync(target, synthesis);
      },
      { expectFailure: true },
    );
  });

  testCase(context, "spec_evaluator_accepts_citation_evidence_chain_and_requires_packet_event", () => {
    runMutatedSpecFixture(context, "spec-duplicate-citation-lines", ({ response }) => {
      response.citations.push({
        path: response.citations[0].path,
        line: 19,
      });
    });

    const extraCitation = runMutatedSpecFixture(context, "spec-extra-citation-source", ({ response }) => {
      response.citations.push({
        path: "AGENTS.md",
        line: 1,
      });
    });
    ensure(
      context,
      extraCitation.stderr.includes("spec citations include additional sources: AGENTS.md"),
      "citation superset passed without an audit warning",
    );

    runMutatedSpecFixture(
      context,
      "spec-missing-finding-citation",
      ({ response }) => {
        response.citations = response.citations.slice(1);
      },
      { expectFailure: true },
    );

    runMutatedSpecFixture(context, "spec-packet-tool-event-only", ({ response }) => {
      response.file_reads = [];
    });

    runMutatedSpecFixture(
      context,
      "spec-missing-packet-tool-event",
      ({ response }) => {
        response.file_reads = [];
        response.tool_events = response.tool_events.filter(
          (event) => !event.command.includes("spec-packet.json"),
        );
      },
      { expectFailure: true },
    );
  });

  testCase(context, "spec_evaluator_rejects_session_owned_archive", () => {
    const archived = runMutatedSpecFixture(
      context,
      "spec-session-archive",
      ({ projectRoot }) => {
        const specs = path.join(projectRoot, "docs", "specs");
        fs.mkdirSync(specs, { recursive: true });
        fs.writeFileSync(path.join(specs, "TASK-20260731-001.md"), "session archive\n");
      },
      { copyProject: true, expectFailure: true },
    );
    ensure(
      context,
      archived.stderr.includes("session ran archive; the evaluator owns the archive step"),
      "session-owned archive rejection did not explain evaluator ownership",
    );
  });

  testCase(context, "spec_evaluator_preserves_d38_d39_d48_semantics", () => {
    runMutatedSpecFixture(context, "spec-failed-tool-warning", ({ response }) => {
      response.tool_events.push({
        name: "Read",
        command: "Read missing optional note",
        at_step: 3,
        ok: false,
      });
    });

    const base = readKyaml(SPEC_FIXTURES[0]);
    const lateCase = path.join(context.root, "spec-late-conflict");
    fs.mkdirSync(lateCase, { recursive: true });
    const lateResponseFile = path.join(lateCase, "kickoff-response.json");
    const lateResponse = readJson(fixturePath(base.kickoff_response));
    const turnEvent = lateResponse.tool_events.find(
      (event) => event.ok && event.command.includes("record-turn.mjs"),
    );
    const conflictEvent = lateResponse.tool_events.find(
      (event) => event.ok && event.command.includes("record-conflicts.mjs"),
    );
    conflictEvent.at_step = turnEvent.at_step + 1;
    writeJson(lateResponseFile, lateResponse);
    runMutatedSpecFixture(
      context,
      "spec-late-conflict-fixture",
      () => {},
      { kickoffResponse: lateResponseFile },
    );

    const wrongResponseFile = path.join(lateCase, "wrong-order-response.json");
    const wrongResponse = readJson(fixturePath(base.kickoff_response));
    const deepEvent = wrongResponse.tool_events.find(
      (event) => event.ok && event.command.includes("gather-context.mjs") && event.command.includes("--phase deep"),
    );
    deepEvent.at_step = 1;
    writeJson(wrongResponseFile, wrongResponse);
    runMutatedSpecFixture(
      context,
      "spec-wrong-kickoff-order",
      () => {},
      { kickoffResponse: wrongResponseFile, expectFailure: true },
    );
  });

  testCase(context, "all_six_m2_fixtures_pass_current_evaluators", () => {
    for (const fixture of KICKOFF_FIXTURES) {
      runNode(context, EVAL_KICKOFF, ["--check-fixture", fixture], { cwd: ROOT });
    }
    for (const fixture of SPEC_FIXTURES) {
      runNode(context, EVAL_SPEC, ["--check-fixture", fixture], { cwd: ROOT });
    }
  });
}

function readStalenessReport(run) {
  return JSON.parse(run.stdout);
}

function assertStalenessShape(context, report) {
  ensure(
    context,
    JSON.stringify(Object.keys(report)) ===
      JSON.stringify(["kind", "version", "scanned_at", "artifacts_scanned", "findings", "staleness_count"]),
    "staleness report fields or canonical order differ from D15",
  );
  ensure(context, report.kind === "kg.staleness_report" && report.version === 1, "staleness report kind/version invalid");
  ensure(context, report.scanned_at === "2026-07-31T09:00:00.000Z", "staleness report clock mismatch");
  ensure(context, report.staleness_count === report.findings.length, "staleness count differs from findings");
  for (const finding of report.findings) {
    ensure(
      context,
      JSON.stringify(Object.keys(finding)) ===
        JSON.stringify(["detection_mode", "artifact_id", "source_ref", "issue", "severity"]),
      "staleness finding fields or canonical order differ from D15",
    );
  }
}

function runHealth(context, project, options = {}) {
  return runNode(
    context,
    options.entrypoint ?? HEALTH_CHECK,
    [
      "--root",
      project,
      "--now",
      "2026-07-31T09:00:00Z",
      ...(options.gates ? ["--gates", "--max-staleness", String(options.maxStaleness ?? 0)] : []),
    ],
    { cwd: project, expectFailure: options.expectFailure === true },
  );
}

function setupStalenessProject(context, name) {
  const caseRoot = path.join(context.root, name);
  const project = path.join(caseRoot, "project");
  fs.cpSync(KICKOFF_COMPILED_PROJECT, project, { recursive: true });
  return { caseRoot, project };
}

function writeSidecarSourceRef(project, sourceRef) {
  const file = path.join(project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml");
  const record = readKyaml(file);
  record.source_refs = [sourceRef];
  fs.writeFileSync(file, harness.renderHarnessSidecar(record));
}

function runSevenStepChain(context) {
  const caseRoot = path.join(context.root, "seven-step-chain");
  const project = path.join(caseRoot, "project");
  const artifacts = path.join(caseRoot, "artifacts");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.cpSync(path.join(BOOTSTRAP_FIXTURE, "host"), project, { recursive: true });
  // The bootstrap fixture carries mixed-case .kg exclusion probes. Under the
  // version 2 host classifier those are migration residuals, so this separate
  // end-to-end install fixture removes them before the init step. Part 2 keeps
  // the exclusion probes and their assertions.
  fs.rmSync(path.join(project, ".KG"), { recursive: true, force: true });
  fs.rmSync(path.join(project, "mixed", ".kG"), { recursive: true, force: true });
  fs.cpSync(
    path.join(COMPILE_FIXTURE, "host", "docs", "accepted-compile-contract.md"),
    path.join(project, "docs", "accepted-compile-contract.md"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(COMPILE_FIXTURE, "host", "docs", "runbooks"),
    path.join(project, "docs", "runbooks"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(COMPILE_FIXTURE, "host", "harness"),
    path.join(project, "harness"),
    { recursive: true },
  );
  writeSidecarSourceRef(project, "docs/architecture/overview.md#L1");

  runNode(
    context,
    INIT_INSTALL,
    [project, "--copy", "--threshold", "2", "--docs-profile", "none", "--project-stage", "brownfield"],
    { cwd: project, env: { KG_ROOT: project } },
  );
  const installed = (skill, script) =>
    path.join(project, ".agents", "skills", skill, "scripts", script);
  ensure(context, fs.existsSync(installed("kg-docs", "inventory.mjs")), "init did not install kg-docs");
  ensure(context, fs.existsSync(installed("kg-scan", "health-check.mjs")), "init did not install staleness health check");

  const inventory = path.join(artifacts, "inventory.json");
  runNode(
    context,
    installed("kg-docs", "inventory.mjs"),
    ["--root", project, "--output", inventory, "--now", "2026-07-31T06:00:00Z"],
    { cwd: project },
  );
  const bootstrapPlan = path.join(artifacts, "bootstrap-plan.json");
  fs.copyFileSync(path.join(ROOT, "scripts", "fixtures", "m2", "bootstrap", "plan.valid.json"), bootstrapPlan);
  runNode(
    context,
    installed("kg-docs", "bootstrap.mjs"),
    ["--project-root", project, "--inventory", inventory, "--plan", bootstrapPlan],
    { cwd: project },
  );
  const architecture = path.join(project, "docs", "architecture", "overview.md");
  const architectureText = fs.readFileSync(architecture, "utf8");
  const architectureHash = fileHash(architecture);

  const observationDraft = path.join(artifacts, "observation.json");
  const observedStatement = readJson(bootstrapPlan).observed_facts[0].statement;
  ensure(context, architectureText.includes(observedStatement), "bootstrap output omitted the planned observed fact");
  writeJson(observationDraft, {
    source: "task_outcome",
    claim: `The bootstrapped architecture records: ${observedStatement}`,
    context: {
      task: "m2-seven-step-chain",
      paths: ["docs/architecture/overview.md"],
    },
    evidence: [
      {
        type: "test",
        ref: `docs/architecture/overview.md#sha256=${architectureHash}`,
      },
    ],
  });
  runNode(
    context,
    installed("kg-observe", "add-observation.mjs"),
    [observationDraft, "--now", "2026-07-31T06:10:00Z"],
    { cwd: project, env: { KG_ROOT: project } },
  );
  const observationFile = path.join(project, ".kg", "observations", "OBS-20260731-001.yaml");
  const observation = readKyaml(observationFile);
  ensure(context, observation.evidence[0].ref.includes(architectureHash), "observe did not consume bootstrap bytes");

  const compilePlan = path.join(artifacts, "compile-plan.json");
  writeJson(compilePlan, {
    kind: "kg.compile_plan",
    version: 1,
    items: [
      {
        observation_id: observation.id,
        result_type: "publish_kn_and_carrier",
        knowledge: {
          claim: observation.claim,
          category: "project_knowledge",
          scope: {
            paths: ["docs/architecture/**", "docs/runbooks/**"],
          },
          authority: "verified_runtime_behavior",
          confidence: 1,
          body: "## Constraint\n\nThe managed runbook records the bootstrapped architecture fact.",
        },
        carrier: {
          artifact_id: "HAR-COMPILE-NOTES",
          content: `Compiled from ${observation.id}: ${observation.claim}`,
        },
      },
    ],
  });
  const compileContext = path.join(artifacts, "compile-context.json");
  runNode(
    context,
    installed("kg-compile", "compile.mjs"),
    ["--root", project, "--output", compileContext, "--now", "2026-07-31T06:20:00Z"],
    { cwd: project, env: { KG_ROOT: project } },
  );
  runNode(
    context,
    installed("kg-compile", "apply-compile-plan.mjs"),
    [
      "--root",
      project,
      "--context",
      compileContext,
      "--plan",
      compilePlan,
      "--now",
      "2026-07-31T06:20:00Z",
    ],
    { cwd: project, env: { KG_ROOT: project } },
  );
  const generatedKnName = fs.readdirSync(path.join(project, "knowledge")).find((name) => name.startsWith("KN-0001-"));
  const generatedKnPath = `knowledge/${generatedKnName}`;
  const generatedKn = readKnowledge(path.join(project, ...generatedKnPath.split("/"))).frontmatter;
  ensure(context, generatedKn.claim === observation.claim, "compile KN did not consume the observation claim");
  ensure(context, generatedKn.source_obs_ids.includes(observation.id), "compile KN lost the observation reverse link");

  const kickoffDir = path.join(artifacts, "kickoff");
  fs.mkdirSync(kickoffDir);
  const indexFile = path.join(kickoffDir, "kickoff-index.json");
  const contextFile = path.join(kickoffDir, "kickoff-context.json");
  const turnInput = path.join(kickoffDir, "kickoff-turn-input.json");
  const turnTranscript = path.join(kickoffDir, "kickoff-turn-transcript.json");
  const turnFile = path.join(kickoffDir, "kickoff-turn.yaml");
  const kickoffTask = "Preserve the bootstrapped architecture fact in the managed compile runbook";
  const gatherScript = installed("kg-kickoff", "gather-context.mjs");
  runNode(
    context,
    gatherScript,
    ["--root", project, "--task", kickoffTask, "--phase", "index", "--output", indexFile],
    { cwd: project },
  );
  const index = readJson(indexFile);
  const findingPaths = [
    generatedKnPath,
    "docs/runbooks/compile-notes.md",
    "docs/architecture/overview.md",
  ];
  for (const sourcePath of findingPaths) {
    ensure(context, index.entries.some((entry) => entry.path === sourcePath), `kickoff index omitted ${sourcePath}`);
  }
  runNode(
    context,
    gatherScript,
    [
      "--root",
      project,
      "--phase",
      "deep",
      "--index",
      indexFile,
      ...findingPaths.flatMap((sourcePath) => ["--include", sourcePath]),
      "--output",
      contextFile,
    ],
    { cwd: project },
  );
  const question = "Should the task update only the managed runbook block?";
  const transcript = {
    transcript: [
      { role: "user", content: kickoffTask },
      { role: "assistant", content: `I recommend the managed block because it preserves human text. ${question}` },
    ],
  };
  writeJson(turnTranscript, transcript);
  const findings = findingPaths.map((sourcePath) => {
    const entry = index.entries.find((item) => item.path === sourcePath);
    return {
      source_path: sourcePath,
      line: sourcePath === "docs/runbooks/compile-notes.md" ? 3 : sourcePath === generatedKnPath ? 3 : 1,
      status: entry.status,
      authority: entry.authority,
    };
  });
  writeJson(turnInput, {
    findings,
    question: {
      question_text: question,
      assistant_message_index: 1,
    },
  });
  runNode(
    context,
    installed("kg-kickoff", "record-turn.mjs"),
    [
      "--project-root",
      project,
      "--index",
      indexFile,
      "--input",
      turnInput,
      "--transcript",
      turnTranscript,
      "--output",
      turnFile,
      "--now",
      "2026-07-31T06:30:00Z",
    ],
    { cwd: project },
  );
  const turn = readKyaml(turnFile);
  ensure(
    context,
    turn.findings.some((finding) => finding.source_path === generatedKnPath) &&
      turn.findings.some((finding) => finding.source_path === "docs/runbooks/compile-notes.md"),
    "kickoff turn did not consume the compiled KN and carrier",
  );

  const kickoffResponse = path.join(kickoffDir, "runner-response.json");
  const kickoffSessionId = "m2-seven-step-kickoff";
  writeJson(kickoffResponse, {
    session_id: kickoffSessionId,
    transcript: transcript.transcript,
    file_reads: findingPaths.map((sourcePath) => ({ path: sourcePath, at_step: 2 })),
    citations: findings.map((finding) => ({ path: finding.source_path, line: finding.line })),
    products: [
      { kind: "kg.kickoff_context_index", path: "kickoff-index.json" },
      { kind: "kg.kickoff_context", path: "kickoff-context.json" },
      { kind: "kg.kickoff_turn", path: "kickoff-turn.yaml" },
    ],
    tool_events: [
      {
        name: "Bash",
        command: "node gather-context.mjs --phase index --output kickoff-index.json",
        at_step: 1,
        ok: true,
      },
      {
        name: "Bash",
        command: `node gather-context.mjs --phase deep ${findingPaths.map((item) => `--include ${item}`).join(" ")} --output kickoff-context.json`,
        at_step: 2,
        ok: true,
      },
      {
        name: "Bash",
        command: "node record-turn.mjs --index kickoff-index.json --output kickoff-turn.yaml",
        at_step: 3,
        ok: true,
      },
    ],
    permission_denials: [],
  });

  const specPacket = path.join(artifacts, "spec-packet.json");
  runNode(
    context,
    installed("kg-spec", "produce-spec.mjs"),
    [
      "--prepare",
      "--project-root",
      project,
      "--transcript",
      kickoffResponse,
      "--kickoff-artifacts",
      kickoffDir,
      "--output",
      specPacket,
    ],
    { cwd: project },
  );
  const specSynthesis = path.join(artifacts, "spec-synthesis.json");
  writeJson(specSynthesis, {
    kind: "kg.spec_synthesis",
    version: 2,
    task: {
      title: "Preserve bootstrap facts in the compile-managed runbook",
    },
    context: [
      observation.claim,
      `The kickoff selected ${turn.findings.length} structured sources.`,
    ],
    requirements: [
      "Update the managed compile runbook block from the compiled knowledge entry.",
    ],
    constraints: turn.findings.map((finding) => ({
      constraint: `Preserve the constraint recorded by ${finding.source_path}.`,
      source_path: `${finding.source_path}#L${finding.line}`,
      source_status: finding.status,
      authority: finding.authority,
    })),
    references: [
      "harness/artifacts/HAR-COMPILE-NOTES.yaml",
    ],
    out_of_scope: [
      {
        statement: "Changing text outside the managed runbook block.",
        conflict_source_path: null,
      },
    ],
    acceptance_criteria: [
      "GIVEN the compiled knowledge entry WHEN the spec is archived THEN the managed runbook constraint remains cited.",
    ],
    open_questions: [],
    session_history: [
      {
        session_id: kickoffSessionId,
        turn_session_id: turn.session_id,
        product_kinds: [
          "kg.kickoff_context_index",
          "kg.kickoff_context",
          "kg.kickoff_turn",
        ],
      },
    ],
  });
  const archived = runNode(
    context,
    installed("kg-spec", "produce-spec.mjs"),
    [
      "--archive",
      "--project-root",
      project,
      "--packet",
      specPacket,
      "--synthesis",
      specSynthesis,
      "--now",
      "2026-07-31T06:40:00Z",
    ],
    { cwd: project },
  );
  const archiveResult = JSON.parse(archived.stdout);
  const archivedSpec = path.join(project, ...archiveResult.path.split("/"));
  ensure(context, fs.existsSync(archivedSpec), "spec archive did not consume the kickoff packet");
  const archivedText = fs.readFileSync(archivedSpec, "utf8");
  ensure(
    context,
    archivedText.includes(kickoffSessionId) && archivedText.includes(generatedKnPath),
    "archived spec lost kickoff or compile provenance",
  );

  const health = runNode(
    context,
    installed("kg-scan", "health-check.mjs"),
    [
      "--root",
      project,
      "--now",
      "2026-07-31T06:50:00Z",
      "--gates",
      "--max-staleness",
      "0",
    ],
    { cwd: project },
  );
  const report = JSON.parse(health.stdout);
  ensure(context, report.artifacts_scanned === 1 && report.staleness_count === 0, "seven-step staleness gate failed");
  ensure(context, fileHash(architecture) === architectureHash, "seven-step chain changed the bootstrap source bytes");
}

function runPart7(context) {
  testCase(context, "scan_reports_one_missing_source_ref", () => {
    const setup = setupStalenessProject(context, "staleness-positive");
    const unreadable = path.join(setup.project, ".kg", "observations");
    fs.mkdirSync(unreadable, { recursive: true });
    fs.writeFileSync(path.join(unreadable, "invalid.yaml"), "invalid and intentionally unread\n");
    fs.writeFileSync(
      path.join(setup.project, "should-not-run.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('host-code-ran', 'bad');\n",
    );
    const healthy = readStalenessReport(runHealth(context, setup.project));
    assertStalenessShape(context, healthy);
    ensure(context, healthy.artifacts_scanned === 1, "healthy fixture did not scan one artifact");
    ensure(context, healthy.staleness_count === 0, "healthy fixture was falsely reported stale");
    ensure(context, !fs.existsSync(path.join(setup.project, "host-code-ran")), "staleness scan executed host code");

    const source = path.join(setup.project, "docs", "accepted-compile-contract.md");
    const moved = path.join(setup.project, "docs", "accepted-compile-contract.moved.md");
    fs.renameSync(source, moved);
    const staleRun = runHealth(context, setup.project);
    const stale = readStalenessReport(staleRun);
    assertStalenessShape(context, stale);
    ensure(context, stale.staleness_count === 1, "corrupted source did not yield count 1");
    ensure(
      context,
      JSON.stringify(stale.findings[0]) ===
        JSON.stringify({
          detection_mode: "deterministic",
          artifact_id: "HAR-COMPILE-NOTES",
          source_ref: "docs/accepted-compile-contract.md#L14",
          issue: "missing_source",
          severity: "high",
        }),
      "missing-source finding differs from D15",
    );
    const gate = runHealth(context, setup.project, { gates: true, expectFailure: true });
    ensure(context, gate.status !== 0, "staleness gate returned zero above the threshold");
    ensure(context, readStalenessReport(gate).staleness_count === 1, "gate output lost the finding");
    fs.renameSync(moved, source);
    const restored = readStalenessReport(runHealth(context, setup.project));
    ensure(context, restored.staleness_count === 0, "restored source remained stale, suggesting cached state");
    const direct = readStalenessReport(
      runHealth(context, setup.project, { entrypoint: STALENESS_CHECK }),
    );
    ensure(context, JSON.stringify(direct) === JSON.stringify(restored), "health-check alias differs from check-staleness");
  });

  testCase(context, "scan_rejects_invalid_sidecar_without_trusted_result", () => {
    const setup = setupStalenessProject(context, "staleness-invalid-sidecar");
    const sidecar = path.join(setup.project, "harness", "artifacts", "HAR-COMPILE-NOTES.yaml");
    fs.writeFileSync(sidecar, fs.readFileSync(sidecar, "utf8").replace("artifact_id: HAR-COMPILE-NOTES\n", ""));
    const rejected = runHealth(context, setup.project, { expectFailure: true });
    ensure(context, rejected.stdout.trim() === "", "invalid sidecar emitted a trusted health report");
  });

  testCase(context, "scan_rejects_kg_escape_and_symlink_source_refs", () => {
    for (const [name, sourceRef, setupHost] of [
      [
        "kg-case",
        ".KG/hidden.md#L1",
        (project) => {
          fs.mkdirSync(path.join(project, ".KG"));
          fs.writeFileSync(path.join(project, ".KG", "hidden.md"), "hidden\n");
        },
      ],
      [
        "escape",
        "../outside.md#L1",
        (project) => {
          fs.writeFileSync(path.join(path.dirname(project), "outside.md"), "outside\n");
        },
      ],
      [
        "symlink",
        "docs/source-alias.md#L1",
        (project) => {
          fs.symlinkSync(
            path.join(project, "docs", "accepted-compile-contract.md"),
            path.join(project, "docs", "source-alias.md"),
          );
        },
      ],
    ]) {
      const setup = setupStalenessProject(context, `staleness-${name}`);
      setupHost(setup.project);
      writeSidecarSourceRef(setup.project, sourceRef);
      const rejected = runHealth(context, setup.project, { expectFailure: true });
      ensure(context, rejected.stdout.trim() === "", `${name} source ref emitted a trusted report`);
    }
  });

  testCase(context, "seven_step_pipeline_consumes_real_outputs", () => {
    runSevenStepChain(context);
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
