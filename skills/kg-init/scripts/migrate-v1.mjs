// M2 v1 to v2 migration.
//
// Phase 0 writes a JSON plan outside the host:
//   node migrate-v1.mjs --root <host> --output <plan.json> [--skills-source <skills-dir>]
//
// Phase 1 and Phase 2 execute and verify only that plan:
//   node migrate-v1.mjs --root <host> --execute --plan <plan.json>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host } from "./_lib.mjs";
import {
  buildMigrationPlan,
  executeMigrationPlan,
  MigrationError,
  QueueMigrationError,
  queueErrorReport,
} from "./migration-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_SOURCE = path.resolve(SCRIPTS_DIR, "..", "..");

function usage() {
  console.log(
    [
      "Usage:",
      "  node migrate-v1.mjs --root <host> --output <plan.json> [--skills-source <skills-dir>] [--now <ISO>]",
      "  node migrate-v1.mjs --root <host> --execute --plan <plan.json>",
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
    skillsSource: DEFAULT_SKILLS_SOURCE,
    now: null,
  };
  const valueFlags = new Set(["--root", "--output", "--plan", "--skills-source", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new MigrationError(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new MigrationError(`${arg} needs a value`);
    if (arg === "--root") parsed.root = path.resolve(value);
    if (arg === "--output") parsed.output = path.resolve(value);
    if (arg === "--plan") parsed.plan = path.resolve(value);
    if (arg === "--skills-source") parsed.skillsSource = path.resolve(value);
    if (arg === "--now") parsed.now = value;
    index += 1;
  }
  if (!parsed.root) throw new MigrationError("--root is required");
  if (parsed.execute) {
    if (!parsed.plan) throw new MigrationError("--execute requires --plan <plan.json>");
    if (parsed.output || parsed.now !== null) {
      throw new MigrationError("--execute cannot be combined with --output or --now");
    }
  } else {
    if (!parsed.output) throw new MigrationError("plan generation requires --output <plan.json>");
    if (parsed.plan) throw new MigrationError("--plan is only valid with --execute");
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
  } else if (args.execute) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(args.plan, "utf8"));
    } catch (error) {
      throw new MigrationError(`cannot read migration plan JSON: ${error.message}`);
    }
    console.log(JSON.stringify(executeMigrationPlan({ root: args.root, plan }), null, 2));
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
  if (error instanceof QueueMigrationError) {
    console.error(JSON.stringify(queueErrorReport(error), null, 2));
  } else {
    console.error(`kg: error: ${error.message}`);
  }
  process.exitCode = 1;
}
