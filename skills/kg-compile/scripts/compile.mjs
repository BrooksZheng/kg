// Build or verify the deterministic input context consumed by an agent-authored
// kg.compile_plan. This command reads compile inputs and writes no host state.
//
// Usage:
//   node compile.mjs --root <host> --output <compile-context.json> [--now <ISO>]
//   node compile.mjs --root <host> --check --context <compile-context.json>

import fs from "node:fs";
import path from "node:path";
import { host, harness } from "./_lib.mjs";

function parseArgs(argv) {
  const out = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      out.check = true;
      continue;
    }
    if (!["--root", "--output", "--context", "--now"].includes(arg)) host.fail(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) host.fail(`${arg} needs a value`);
    const key = arg.slice(2);
    if (out[key]) host.fail(`${arg} may be supplied only once`);
    out[key] = value;
    index += 1;
  }
  if (!out.root) out.root = host.findHostRoot();
  if (out.check) {
    if (!out.context || out.output || out.now) {
      host.fail("usage: compile.mjs --root <host> --check --context <compile-context.json>");
    }
  } else if (!out.output || out.context) {
    host.fail("usage: compile.mjs --root <host> --output <compile-context.json> [--now <ISO>]");
  }
  return out;
}

function assertContextFile(file, label, { mustExist }) {
  const resolved = path.resolve(file);
  if (host.hasPathSegment(resolved, ".kg")) throw new Error(`${label} must not be inside .kg`);
  if (fs.existsSync(resolved)) {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    if (!fs.statSync(resolved).isFile()) throw new Error(`${label} must be a file`);
  } else if (mustExist) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  host.canonicalPath(resolved);
  return resolved;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.kg-context-write.tmp`);
  try {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const root = host.assertSafeHostRoot(args.root);
    if (args.check) {
      const contextFile = assertContextFile(args.context, "compile context", { mustExist: true });
      const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
      harness.assertCompileContextCurrent(root, context);
      console.log(`kg: compile context is current (${context.context_digest})`);
      return;
    }
    const output = assertContextFile(args.output, "compile context output", { mustExist: false });
    if (fs.existsSync(output)) throw new Error(`refusing to overwrite compile context: ${output}`);
    const context = harness.buildCompileContext(root, { now: args.now });
    writeJsonAtomic(output, context);
    console.log(JSON.stringify(context));
  } catch (error) {
    host.fail(error.message);
  }
}

main();
