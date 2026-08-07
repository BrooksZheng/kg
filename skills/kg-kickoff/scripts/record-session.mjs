#!/usr/bin/env node

// Create immutable kickoff session snapshots. Turns are written separately;
// an advance snapshot appends one validated scope and turn reference.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { host, kyaml, machineContract, protocol } from "./_lib.mjs";

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { action: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--start", "--advance", "--complete"].includes(flag)) {
      if (out.action) fail("choose exactly one session action");
      out.action = flag.slice(2);
      continue;
    }
    if (!["--task", "--index", "--session", "--scope", "--turn", "--output", "--now"].includes(flag)) {
      fail(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    const key = flag.slice(2);
    if (out[key] !== undefined) fail(`${flag} may be provided once`);
    out[key] = value;
    index += 1;
  }
  if (!out.action || !out.output) fail("usage: record-session.mjs (--start|--advance|--complete) ... --output <file>");
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) fail(`invalid --now: ${out.now}`);
  return { ...out, now };
}

function readMachineFile(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const file = path.resolve(value);
  if (host.hasPathSegment(file, ".kg") || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`${label} is unsafe or missing`);
  }
  try {
    const text = fs.readFileSync(file, "utf8");
    const value = path.extname(file).toLowerCase() === ".json" || text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : kyaml.parse(text);
    return { file: host.canonicalPath(file), value };
  } catch (error) {
    throw new Error(`${label} must be a machine record: ${error.message}`);
  }
}

function outputFile(value) {
  const file = path.resolve(value);
  if (![".json", ".yaml"].includes(path.extname(file).toLowerCase()) || host.hasPathSegment(file, ".kg")) {
    throw new Error("output must be a JSON or YAML file outside .kg");
  }
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite session snapshot: ${file}`);
  return file;
}

function validateProduct(product, schema, label) {
  const errors = protocol.validateRecord(product.value, schema);
  if (errors.length > 0) throw new Error(`${label} is invalid: ${errors.join("; ")}`);
  return product;
}

function start(args, schema) {
  if (typeof args.task !== "string" || args.task === "" || !args.index) throw new Error("--start requires --task and --index");
  const index = validateProduct(readMachineFile(args.index, "index"), protocol.loadKickoffIndexSchema(), "index");
  const taskSha256 = machineContract.sha256Bytes(args.task);
  if (taskSha256 !== index.value.task_sha256) throw new Error("task bytes differ from the index task hash");
  const seed = machineContract.sha256CanonicalJson({ task_sha256: taskSha256, index_sha256: machineContract.sha256File(index.file) });
  return machineContract.canonicalizeRecord({
    kind: schema.product_kind,
    version: schema.product_version,
    session_id: `KSESSION-${seed.slice(-12).toUpperCase()}`,
    started_at: args.now.toISOString(),
    updated_at: args.now.toISOString(),
    task_sha256: taskSha256,
    index_ref: index.file,
    scope_refs: [],
    turn_refs: [],
    next_turn_sequence: 1,
    status: "active",
  }, schema, "kickoff session");
}

function advance(args, schema) {
  if (!args.session || !args.scope || !args.turn) throw new Error("--advance requires --session, --scope, and --turn");
  const session = validateProduct(readMachineFile(args.session, "session"), schema, "session");
  if (session.value.status !== "active") throw new Error("only an active session can advance");
  const scope = validateProduct(readMachineFile(args.scope, "scope"), protocol.loadKickoffScopeSchema(), "scope");
  const turn = readMachineFile(args.turn, "turn");
  const turnErrors = protocol.validateRecord(turn.value, protocol.loadKickoffTurnSchema());
  if (turnErrors.length > 0) throw new Error(`turn is invalid: ${turnErrors.join("; ")}`);
  if (scope.value.task_sha256 !== session.value.task_sha256 || turn.value.session_id !== session.value.session_id) {
    throw new Error("scope or turn belongs to a different session task");
  }
  if (turn.value.sequence !== session.value.next_turn_sequence) throw new Error("turn sequence does not match next_turn_sequence");
  return machineContract.canonicalizeRecord({
    ...session.value,
    updated_at: args.now.toISOString(),
    scope_refs: [...session.value.scope_refs, scope.file],
    turn_refs: [...session.value.turn_refs, turn.file],
    next_turn_sequence: session.value.next_turn_sequence + 1,
  }, schema, "kickoff session");
}

function complete(args, schema) {
  if (!args.session) throw new Error("--complete requires --session");
  const session = validateProduct(readMachineFile(args.session, "session"), schema, "session");
  if (session.value.status !== "active") throw new Error("only an active session can complete");
  return machineContract.canonicalizeRecord({ ...session.value, updated_at: args.now.toISOString(), status: "completed" }, schema, "kickoff session");
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const schema = protocol.loadKickoffSessionSchema();
    const output = outputFile(args.output);
    const record = args.action === "start" ? start(args, schema) : args.action === "advance" ? advance(args, schema) : complete(args, schema);
    machineContract.writeCanonicalRecord(output, record, schema, { label: "kickoff session" });
    console.log(`kg: wrote ${record.status} session snapshot ${record.session_id}; next turn ${record.next_turn_sequence}`);
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
