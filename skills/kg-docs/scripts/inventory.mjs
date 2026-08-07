#!/usr/bin/env node

// Produce one static repository inventory as strict JSON.

import fs from "node:fs";
import path from "node:path";
import { host, repository } from "./_lib.mjs";

function parsePositive(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) host.fail(`${flag} needs a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const out = { exclude: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--root", "--output", "--now", "--max-files", "--max-bytes", "--max-evidence", "--exclude"].includes(flag)) {
      host.fail(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) host.fail(`${flag} needs a value`);
    if (flag === "--exclude") out.exclude.push(value);
    else out[flag.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (!out.root || !out.output) host.fail("usage: inventory.mjs --root <project-root> --output <inventory.json>");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(args.output);
if (host.hasPathSegment(output, ".kg")) host.fail(`inventory output must not be inside .kg: ${output}`);
if (fs.existsSync(output)) host.fail(`refusing to overwrite inventory: ${output}`);

let inventory;
try {
  inventory = repository.buildRepositoryInventory({
    root: args.root,
    now: args.now,
    maxFiles: args.max_files ? parsePositive(args.max_files, "--max-files") : undefined,
    maxBytesPerFile: args.max_bytes ? parsePositive(args.max_bytes, "--max-bytes") : undefined,
    maxEvidence: args.max_evidence ? parsePositive(args.max_evidence, "--max-evidence") : undefined,
    exclude: args.exclude,
  });
} catch (error) {
  host.fail(error.message);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
console.log(`kg: repository inventory written to ${output}`);
