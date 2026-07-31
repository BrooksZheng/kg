// Validate observation files against protocol/observation.schema.yaml
// without writing anything.
//
// Usage:
//   node skills/kg-observe/scripts/validate-observations.mjs           # whole inbox
//   node skills/kg-observe/scripts/validate-observations.mjs <file>... # specific files
//   node skills/kg-observe/scripts/validate-observations.mjs --self-check
//
// Also checks that each inbox filename matches its `id`. Exits 1 if any file
// is invalid.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

const rawArgs = process.argv.slice(2);
const unknownOptions = rawArgs.filter((arg) => arg.startsWith("--") && arg !== "--self-check");
if (unknownOptions.length) host.fail(`unknown option(s): ${unknownOptions.join(", ")}`);
const selfCheck = rawArgs.includes("--self-check");
const args = rawArgs.filter((arg) => !arg.startsWith("--"));
if (selfCheck && args.length) host.fail("--self-check cannot be combined with observation files");

if (selfCheck) {
  const schema = protocol.loadObservationSchema();
  const valid = {
    id: "OBS-20260731-001",
    at: "2026-07-31T00:00:00Z",
    source: "task_outcome",
    claim: "The validator self-check uses only an in-memory observation.",
    context: { task: "validator-self-check", paths: ["skills/kg-observe/**"] },
    evidence: [{ type: "test", ref: "validate-observations --self-check" }],
    urgency: "batch",
  };
  const processed = { ...valid, compiled_to_kn: "KN-0001" };
  const strictFailure = { ...valid, unknown_field: true };
  const problems = [];
  if (protocol.validateRecord(valid, schema).length !== 0) problems.push("valid observation was rejected");
  if (protocol.validateRecord(processed, schema).length !== 0) problems.push("processed trace was rejected");
  if (!protocol.validateRecord(strictFailure, schema).some((error) => error.includes("unknown field"))) {
    problems.push("unknown field was accepted");
  }
  const roundTrip = kyaml.parse(kyaml.stringify(processed));
  if (JSON.stringify(roundTrip) !== JSON.stringify(processed)) problems.push("canonical KYAML round trip changed the record");
  if (problems.length) {
    console.error("kg: observation validator self-check FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("kg: observation validator self-check OK (in-memory valid, strict unknown, processed trace)");
  process.exit(0);
}

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
const files = args.length ? args : host.listFiles(paths.observations, ".yaml");

if (files.length === 0) {
  console.log("kg: no observation files to validate.");
  process.exit(0);
}

const schema = protocol.loadObservationSchema();
let bad = 0;
for (const file of files) {
  const label = path.relative(process.cwd(), file) || file;
  let errors;
  try {
    const record = kyaml.parse(fs.readFileSync(file, "utf8"));
    errors = protocol.validateRecord(record, schema);
    if (record.id && path.basename(file) !== `${record.id}.yaml`) {
      errors.push(`filename should be ${record.id}.yaml`);
    }
  } catch (err) {
    errors = [`not valid KYAML — ${err.message}`];
  }
  if (errors.length) {
    bad += 1;
    console.error(`FAIL ${label}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

console.log(`kg: ${files.length - bad}/${files.length} observation(s) valid`);
process.exit(bad ? 1 : 0);
