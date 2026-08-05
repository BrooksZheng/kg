#!/usr/bin/env node

// Build the read-only input packet consumed by an agent-assisted scan session.
// The packet has no kg.* product identity. Only kg.scan_agent_report is a new
// R5.4 machine product.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidencePacket, outputFile } from "./agent-report-core.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { sources: [] };
  const singles = new Set(["--project-root", "--base-report", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--source" && !singles.has(flag)) fail(`unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    if (flag === "--source") out.sources.push(value);
    else {
      const key = flag.slice(2).replaceAll("-", "_");
      if (out[key] !== undefined) fail(`${flag} may be provided once`);
      out[key] = value;
    }
    index += 1;
  }
  for (const field of ["project_root", "base_report", "output"]) {
    if (!out[field]) fail(`missing --${field.replaceAll("_", "-")}`);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const output = outputFile(args.output, "evidence packet", [".json"], args.project_root);
    const packet = buildEvidencePacket({
      projectRoot: args.project_root,
      baseReport: args.base_report,
      sourcePaths: args.sources,
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx" });
    console.log(`kg: wrote scan evidence packet with ${packet.sources.length} source(s)`);
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
