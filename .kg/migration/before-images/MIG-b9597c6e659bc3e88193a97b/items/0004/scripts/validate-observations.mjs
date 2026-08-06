// Validate observation files against protocol/observation.schema.yaml
// without writing anything.
//
// Usage:
//   node skills/kg-observe/scripts/validate-observations.mjs           # whole inbox
//   node skills/kg-observe/scripts/validate-observations.mjs <file>... # specific files
//
// Also checks that each inbox filename matches its `id`. Exits 1 if any file
// is invalid.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
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
