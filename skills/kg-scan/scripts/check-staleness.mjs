#!/usr/bin/env node

// Public CLI for the deterministic report builder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScanReport } from "./report-builder.mjs";
import { host } from "./_lib.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exitCode = 1;
}

function parseNonNegativeInteger(value, flag) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${flag} needs a non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

function parseArgs(argv) {
  const out = { gates: false, max_staleness: 0 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--gates") {
      if (seen.has(flag)) throw new Error("--gates may be provided only once");
      seen.add(flag);
      out.gates = true;
      continue;
    }
    if (!["--root", "--output", "--now", "--max-staleness"].includes(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once`);
    seen.add(flag);
    out[key] = key === "max_staleness" ? parseNonNegativeInteger(value, flag) : value;
    index += 1;
  }
  if (!out.root) throw new Error("--root is required");
  return out;
}

function writeReport(report, outputValue) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (!outputValue) {
    process.stdout.write(text);
    return;
  }
  const output = path.resolve(outputValue);
  if (host.hasPathSegment(output, ".kg") || host.hasPathSegment(host.canonicalPath(output), ".kg")) {
    throw new Error(`report output must not be inside .kg: ${output}`);
  }
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite report: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text, { flag: "wx" });
  process.stdout.write(text);
}

// Keep the original library entrypoint available to callers while both public
// CLIs consume the shared builder.
export function scanStaleness(rootValue, nowValue) {
  return buildScanReport(rootValue, nowValue);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    const report = scanStaleness(args.root, args.now);
    writeReport(report, args.output);
    if (args.gates && (report.hard_error_count > 0 || report.staleness_count > args.max_staleness)) {
      console.error(
        `kg: staleness gate failed: ${report.hard_error_count} hard error(s), ${report.staleness_count} staleness finding(s), maximum ${args.max_staleness}`,
      );
      process.exitCode = 2;
    }
  } catch (error) {
    fail(error.message);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) main();
