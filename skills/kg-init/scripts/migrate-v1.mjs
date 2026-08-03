// v1 to v2 migration.
//
// Phase 0 writes a JSON plan outside the host:
//   node migrate-v1.mjs --root <host> --output <plan.json> [--skills-source <skills-dir>]
//
// Phase 1 and Phase 2 execute and verify a supplied or sealed plan:
//   node migrate-v1.mjs --root <host> --execute [--plan <plan.json>]
//   node migrate-v1.mjs --root <host> --resolve <resolution.json> [--plan <plan.json>]
//   node migrate-v1.mjs --root <host> --rollback [--plan <plan.json>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host } from "./_lib.mjs";
import {
  buildMigrationPlan,
  executeMigrationPlan,
  MigrationError,
  migrationErrorReport,
  recoverMigrationPlan,
  resolveMigrationQuarantine,
  rollbackMigrationPlan,
} from "./migration-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_SOURCE = path.resolve(SCRIPTS_DIR, "..", "..");

function usage() {
  console.log(
    [
      "Usage:",
      "  node migrate-v1.mjs --root <host> --output <plan.json> [--skills-source <skills-dir>] [--now <ISO>]",
      "  node migrate-v1.mjs --root <host> --execute [--plan <plan.json>]",
      "  node migrate-v1.mjs --root <host> --resolve <resolution.json> [--plan <plan.json>]",
      "  node migrate-v1.mjs --root <host> --rollback [--plan <plan.json>]",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const parsed = {
    root: null,
    output: null,
    plan: null,
    execute: false,
    resolve: null,
    rollback: false,
    skillsSource: DEFAULT_SKILLS_SOURCE,
    now: null,
  };
  const valueFlags = new Set(["--root", "--output", "--plan", "--resolve", "--skills-source", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (arg === "--rollback") {
      parsed.rollback = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new MigrationError(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new MigrationError(`${arg} needs a value`);
    if (arg === "--root") parsed.root = path.resolve(value);
    if (arg === "--output") parsed.output = path.resolve(value);
    if (arg === "--plan") parsed.plan = path.resolve(value);
    if (arg === "--resolve") parsed.resolve = path.resolve(value);
    if (arg === "--skills-source") parsed.skillsSource = path.resolve(value);
    if (arg === "--now") parsed.now = value;
    index += 1;
  }
  if (!parsed.root) throw new MigrationError("--root is required");
  const actionCount = [parsed.execute, parsed.resolve !== null, parsed.rollback].filter(Boolean).length;
  if (actionCount > 1) throw new MigrationError("--execute, --resolve, and --rollback are mutually exclusive");
  if (actionCount === 1) {
    if (parsed.output || parsed.now !== null) {
      throw new MigrationError("migration actions cannot be combined with --output or --now");
    }
    if (parsed.skillsSource !== DEFAULT_SKILLS_SOURCE) {
      throw new MigrationError("--skills-source is only valid during Phase 0 plan generation");
    }
  } else {
    if (!parsed.output) throw new MigrationError("plan generation requires --output <plan.json>");
    if (parsed.plan) throw new MigrationError("--plan is only valid with a migration action");
  }
  return parsed;
}

function writePlanOutsideHost(root, output, plan) {
  const canonicalRoot = host.assertSafeHostRoot(root);
  if (!host.isOutside(canonicalRoot, output)) {
    throw new MigrationError("migration plan output must be outside the host root");
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(temporary, output);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else if (args.execute || args.resolve || args.rollback) {
    const recovered = recoverMigrationPlan({
      root: args.root,
      externalPlanPath: args.plan,
      allowCompleted: true,
    });
    let result;
    if (args.resolve) {
      let resolution;
      try {
        resolution = JSON.parse(fs.readFileSync(args.resolve, "utf8"));
      } catch (error) {
        throw new MigrationError(`cannot read migration resolution JSON: ${error.message}`);
      }
      result = resolveMigrationQuarantine({ root: args.root, plan: recovered.plan, resolution });
    } else if (args.rollback) {
      result = rollbackMigrationPlan({ root: args.root, plan: recovered.plan });
    } else {
      result = executeMigrationPlan({ root: args.root, plan: recovered.plan });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked_on_quarantine") process.exitCode = 2;
  } else {
    const plan = buildMigrationPlan({
      root: args.root,
      skillsSource: args.skillsSource,
      now: args.now ?? new Date().toISOString(),
    });
    writePlanOutsideHost(args.root, args.output, plan);
    console.log(JSON.stringify(plan, null, 2));
  }
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(JSON.stringify(migrationErrorReport(error), null, 2));
  } else {
    try {
      console.error(JSON.stringify(migrationErrorReport(new MigrationError(error.message)), null, 2));
    } catch {
      console.error(`kg: error: ${error.message}`);
    }
  }
  process.exitCode = 1;
}
