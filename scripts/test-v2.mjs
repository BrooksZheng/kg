// Black-box deterministic runner for the seven M2 walking-skeleton parts.
// R2.1 implements Part 2 and Part 3. Other registered parts report pending.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = "2026-07-31T00:00:00Z";
const PARTS = [
  { number: 1, name: "migration_v1_minimal_preserves_assets", status: "pending" },
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
const EVAL_BOOTSTRAP = path.join(ROOT, "scripts", "eval-bootstrap.mjs");
const MOCK_BOOTSTRAP_RUNNER = path.join(ROOT, "scripts", "fixtures", "m2", "mock-bootstrap-runner.mjs");
const BOOTSTRAP_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "bootstrap");
const OBSERVE_FIXTURE = path.join(ROOT, "scripts", "fixtures", "m2", "observe");

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
