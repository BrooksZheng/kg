// Append one validated observation to the host's .kg/observations/ inbox.
//
// Usage:
//   node skills/kg-observe/scripts/add-observation.mjs <draft.yaml>
//   ... | node skills/kg-observe/scripts/add-observation.mjs --stdin
//
// The draft is a KYAML observation (protocol/observation.schema.yaml).
// Convenience fills applied before validation:
//   - id:  omitted or `auto` -> next OBS-YYYYMMDD-NNN
//   - at:  omitted           -> now (UTC)
//   - urgency: omitted       -> fast_track for human_correction, else batch
// Malformed observations are rejected with the full error list; nothing is
// written. The inbox is append-only: this script never overwrites a file.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";
import { pendingStatus, printStatus } from "./check-threshold.mjs";

function readInput() {
  const args = process.argv.slice(2);
  if (args.includes("--stdin")) return fs.readFileSync(0, "utf8");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) host.fail("usage: add-observation.mjs <draft.yaml> | --stdin");
  if (!fs.existsSync(file)) host.fail(`draft file not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
if (!fs.existsSync(paths.observations)) {
  host.fail(`.kg/observations/ not found under ${hostRoot} — run kg-init first (or set KG_ROOT)`);
}

let record;
try {
  record = kyaml.parse(readInput());
} catch (err) {
  host.fail(`draft is not valid KYAML — ${err.message}`);
}

const schema = protocol.loadObservationSchema();
if (!record.id || record.id === "auto") record.id = host.nextObservationId(paths);
if (!record.at) record.at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
if (!record.urgency) {
  record.urgency = schema.defaults.urgency_by_source?.[record.source] ?? schema.defaults.urgency;
}

const errors = protocol.validateRecord(record, schema);
if (errors.length) {
  console.error(`kg: observation rejected (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// Canonical field order for the file on disk.
record = {
  id: record.id,
  at: record.at,
  source: record.source,
  claim: record.claim,
  context: record.context,
  evidence: record.evidence,
  urgency: record.urgency,
};

const outFile = path.join(paths.observations, `${record.id}.yaml`);
if (fs.existsSync(outFile)) host.fail(`refusing to overwrite existing observation ${outFile}`);
fs.writeFileSync(outFile, kyaml.stringify(record));
console.log(`kg: recorded ${record.id} -> ${path.relative(process.cwd(), outFile) || outFile}`);

if (record.urgency === "fast_track") {
  console.log("kg: urgency is fast_track — start a kg-compile session NOW for this single observation.");
}
printStatus(pendingStatus(hostRoot));
