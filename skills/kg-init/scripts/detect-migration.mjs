// M2 migration detection. This round identifies the healthy v1 fixture and
// reports other shapes without attempting the full M3 classification matrix.

import path from "node:path";
import { detectMigration, MigrationError } from "./migration-lib.mjs";

function usage() {
  console.log("Usage: node detect-migration.mjs --root <host-root>");
}

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  let root = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--root") throw new MigrationError(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new MigrationError("--root needs a directory");
    root = path.resolve(value);
    index += 1;
  }
  if (!root) throw new MigrationError("--root is required");
  return { root };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else {
    console.log(JSON.stringify(detectMigration(args.root), null, 2));
  }
} catch (error) {
  console.error(`kg: error: ${error.message}`);
  process.exitCode = 1;
}
