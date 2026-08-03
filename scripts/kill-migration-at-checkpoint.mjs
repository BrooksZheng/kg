import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`checkpoint-driver: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) fail("missing -- before the child script");
  const own = argv.slice(0, separator);
  const child = argv.slice(separator + 1);
  const values = {};
  for (let index = 0; index < own.length; index += 2) {
    const flag = own[index];
    const value = own[index + 1];
    if (!value || !["--checkpoint", "--mode", "--ready", "--release", "--cwd"].includes(flag)) {
      fail(`invalid option: ${flag ?? "missing"}`);
    }
    if (values[flag]) fail(`duplicate option: ${flag}`);
    values[flag] = value;
  }
  for (const flag of ["--checkpoint", "--mode", "--ready", "--release", "--cwd"]) {
    if (!values[flag]) fail(`missing ${flag}`);
  }
  if (!["kill", "release"].includes(values["--mode"])) fail("--mode must be kill or release");
  if (child.length === 0) fail("missing child script");
  return {
    checkpoint: values["--checkpoint"],
    mode: values["--mode"],
    ready: path.resolve(values["--ready"]),
    release: path.resolve(values["--release"]),
    cwd: path.resolve(values["--cwd"]),
    script: path.resolve(child[0]),
    args: child.slice(1),
  };
}

function waitForReady(file, child) {
  if (fs.existsSync(file)) return Promise.resolve();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      child.off("close", onClose);
      callback(value);
    };
    const inspect = () => {
      if (fs.existsSync(file)) finish(resolve);
    };
    const poll = setInterval(inspect, 5);
    const timeout = setTimeout(() => finish(reject, new Error(`checkpoint was not reached: ${file}`)), 30000);
    const onClose = (status, signal) => {
      finish(reject, new Error(`child exited before checkpoint: status=${status} signal=${signal}`));
    };
    child.on("close", onClose);
    inspect();
  });
}

const args = parseArgs(process.argv.slice(2));
fs.rmSync(args.ready, { force: true });
fs.rmSync(args.release, { force: true });
const child = spawn(process.execPath, [args.script, ...args.args], {
  cwd: args.cwd,
  env: {
    ...process.env,
    KG_MIGRATION_TEST_SEAM: JSON.stringify({
      checkpoint: args.checkpoint,
      ready: args.ready,
      release: args.release,
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitForReady(args.ready, child);
} catch (error) {
  child.kill("SIGKILL");
  fail(error.message);
}

if (args.mode === "kill") child.kill("SIGKILL");
else fs.writeFileSync(args.release, `${args.checkpoint}\n`, { flag: "wx" });

const closed = await new Promise((resolve) => {
  child.once("close", (status, signal) => resolve({ status, signal }));
});
if (args.mode === "kill" && closed.signal !== "SIGKILL") fail(`expected SIGKILL, got ${closed.signal ?? closed.status}`);
if (args.mode === "release" && closed.status !== 0 && closed.status !== 2) {
  fail(`released child failed with status ${closed.status}: ${stderr}`);
}
console.log(JSON.stringify({
  checkpoint: args.checkpoint,
  mode: args.mode,
  ready: fs.readFileSync(args.ready, "utf8").trim(),
  status: closed.status,
  signal: closed.signal,
  stdout,
  stderr,
}));
