// Resolve one pending queue item through a canonical, strict writer.
//
// Usage:
//   node resolve-queue-item.mjs <Q-id|queue-file> <accepted|rejected> [--note <text>]
//   node resolve-queue-item.mjs --queue <Q-id|queue-file> --resolution <value> [--note <text>]
//
// The input queue record is parsed and validated before any write. Its raw
// keys must be unique, unknown keys are rejected, and the output is rebuilt in
// protocol/queue.schema.yaml field order.

import fs from "node:fs";
import path from "node:path";
import { kyaml, host, protocol } from "./_lib.mjs";

function fail(message) {
  host.fail(message);
}

function parseArgs(argv) {
  const positional = [];
  const out = { queue: null, resolution: null, note: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--queue" || arg === "--resolution" || arg === "--note" || arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
      const key = arg.slice(2);
      if (out[key] !== null && out[key] !== undefined) fail(`${arg} may be supplied only once`);
      out[key] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown option: ${arg}`);
    positional.push(arg);
  }
  if (out.root) process.env.KG_ROOT = path.resolve(out.root);
  if (positional.length > 2) fail("usage: resolve-queue-item.mjs <Q-id|queue-file> <accepted|rejected> [--note <text>]");
  if (!out.queue && positional[0]) out.queue = positional[0];
  if (!out.resolution && positional[1]) out.resolution = positional[1];
  if (!out.queue || !out.resolution) {
    fail("usage: resolve-queue-item.mjs <Q-id|queue-file> <accepted|rejected> [--note <text>]");
  }
  return out;
}

function queueFile(root, value) {
  const paths = host.kgPaths(root);
  const input = String(value);
  if (/^Q-[0-9]{8}-[0-9]{3}$/.test(input)) {
    return path.join(paths.queue, `${input}.yaml`);
  }
  const resolved = path.isAbsolute(input) ? input : path.resolve(root, input);
  const canonical = host.canonicalPath(resolved);
  if (host.isOutside(paths.queue, canonical)) fail(`queue item must be inside .kg/queue: ${input}`);
  return resolved;
}

function canonicalQueue(record, schema) {
  const fields = schema.field_order;
  const canonical = {};
  for (const field of fields) canonical[field] = record[field];
  return canonical;
}

const args = parseArgs(process.argv.slice(2));
const root = host.assertSafeHostRoot(host.findHostRoot());
const file = queueFile(root, args.queue);
if (!fs.existsSync(file)) fail(`queue item not found: ${file}`);
if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail(`queue item must be a regular file: ${file}`);

let raw;
try {
  raw = fs.readFileSync(file, "utf8");
} catch (error) {
  fail(`queue item could not be read: ${error.message}`);
}

let record;
try {
  record = kyaml.parse(raw);
} catch (error) {
  fail(`queue item rejected before write: ${error.message}`);
}

const schema = protocol.loadQueueSchema();
const errors = protocol.validateRecord(record, schema);
if (errors.length) fail(`queue item is invalid: ${errors.join("; ")}`);
if (record.resolution !== "pending") {
  fail(`queue item ${record.id} has already been resolved as ${record.resolution}; double ruling is forbidden`);
}

const allowed = protocol.loadRouting().queue_resolutions;
if (!Array.isArray(allowed) || !allowed.includes(args.resolution)) {
  fail(`resolution must be one of the protocol queue_resolutions: ${Array.isArray(allowed) ? allowed.join(" | ") : "unavailable"}`);
}
if (args.resolution === "pending") fail("resolution writer accepts a final ruling, not pending");
if (args.note !== null && args.note.trim() === "") fail("--note must be non-empty when supplied");

const updated = canonicalQueue(
  {
    ...record,
    resolution: args.resolution,
    resolution_note: args.note ?? null,
  },
  schema,
);
const updatedErrors = protocol.validateRecord(updated, schema);
if (updatedErrors.length) fail(`resolved queue item is invalid: ${updatedErrors.join("; ")}`);

const rendered = kyaml.stringify(updated);
const temporary = path.join(path.dirname(file), `.${path.basename(file)}.kg-resolution-write.tmp`);
try {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, rendered, { flag: "wx" });
  fs.renameSync(temporary, file);
} finally {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
}
host.appendRoundAction(host.kgPaths(root), {
  action: "resolve",
  queue: record.id,
  actor: "human",
  resolution: args.resolution,
});
console.log(`kg: resolved ${record.id} -> ${args.resolution}`);
