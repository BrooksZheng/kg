// Append one validated observation to the host's .kg/observations/ inbox.
//
// Usage:
//   node add-observation.mjs <draft.json> [--now ISO]
//   ... | node add-observation.mjs --stdin [--now ISO]
//
// Agent input is strict JSON. Storage remains canonical KYAML.
// The script owns id and at. Compile owns compiled_to_kn. Agent drafts that
// submit any of those fields are rejected before the canonical rebuild.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";
import { pendingStatus, printStatus } from "./check-threshold.mjs";

function parseArgs(argv) {
  const out = { stdin: false, input: null, now: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdin") {
      out.stdin = true;
      continue;
    }
    if (arg === "--now") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) host.fail("--now needs an ISO-8601 timestamp");
      out.now = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) host.fail(`unknown option: ${arg}`);
    if (out.input) host.fail("only one JSON draft may be submitted");
    out.input = arg;
  }
  if (out.stdin === Boolean(out.input)) {
    host.fail("usage: add-observation.mjs <draft.json> [--now ISO] | --stdin [--now ISO]");
  }
  return out;
}

function parseNow(value) {
  const now = value ? new Date(value) : new Date();
  if (Number.isNaN(now.getTime())) host.fail(`invalid --now timestamp: ${value}`);
  return now;
}

const args = parseArgs(process.argv.slice(2));
let inputText;
if (args.stdin) {
  inputText = fs.readFileSync(0, "utf8");
} else {
  const inputFile = path.resolve(args.input);
  if (host.hasPathSegment(inputFile, ".kg")) host.fail(`draft path must not be inside .kg: ${args.input}`);
  if (!fs.existsSync(inputFile) || !fs.statSync(inputFile).isFile()) host.fail(`draft file not found: ${args.input}`);
  inputText = fs.readFileSync(inputFile, "utf8");
}

let hostRoot;
try {
  hostRoot = host.assertSafeHostRoot(host.findHostRoot());
} catch (error) {
  host.fail(error.message);
}
const paths = host.kgPaths(hostRoot);
if (!fs.existsSync(paths.observations)) {
  host.fail(`.kg/observations/ not found under ${hostRoot}; run kg-init first or set KG_ROOT`);
}

let raw;
try {
  raw = JSON.parse(inputText);
} catch (error) {
  host.fail(`draft is not valid JSON: ${error.message}`);
}
if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
  host.fail("observation draft must be a JSON object");
}

const schema = protocol.loadObservationSchema();
const knownTopFields = new Set(Object.keys(schema.fields).map((field) => field.split(/[.\[]/)[0]));
const unknown = Object.keys(raw).filter((field) => !knownTopFields.has(field));
if (unknown.length) host.fail(`unknown observation field(s): ${unknown.join(", ")}`);

const forbidden = ["id", "at", "compiled_to_kn"].filter((field) => Object.hasOwn(raw, field));
if (forbidden.length) host.fail(`agent draft sets script-owned field(s): ${forbidden.join(", ")}`);

const now = parseNow(args.now);
let record = {
  ...raw,
  id: host.nextObservationId(paths, now),
  at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  urgency: raw.urgency ?? schema.defaults.urgency_by_source?.[raw.source] ?? schema.defaults.urgency,
};

const errors = protocol.validateRecord(record, schema);
if (errors.length) {
  console.error(`kg: observation rejected (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

// Canonical schema order. Undefined optional fields are omitted by stringify.
record = {
  id: record.id,
  at: record.at,
  source: record.source,
  claim: record.claim,
  context: record.context,
  evidence: record.evidence,
  urgency: record.urgency,
  compiled_to_kn: undefined,
};

const outFile = path.join(paths.observations, `${record.id}.yaml`);
try {
  fs.writeFileSync(outFile, kyaml.stringify(record), { flag: "wx" });
} catch (error) {
  if (error?.code === "EEXIST") host.fail(`refusing to overwrite existing observation ${outFile}`);
  throw error;
}
console.log(`kg: recorded ${record.id} -> ${path.relative(process.cwd(), outFile) || outFile}`);

if (record.urgency === "fast_track") {
  console.log("kg: urgency is fast_track; start a kg-compile session now for this single observation.");
}
printStatus(pendingStatus(hostRoot));
