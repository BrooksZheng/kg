// File an item into .kg/queue/ for human ruling (git-native queue, RFC D4).
//
// Usage:
//   node skills/kg-compile/scripts/add-queue-item.mjs <draft.yaml>
//   ... | node skills/kg-compile/scripts/add-queue-item.mjs --stdin
//
// Draft format (KYAML; id/at/resolution filled automatically):
//   kind: conflict | promotion | proposal
//   category: <one of routing categories>
//   claim: "<what needs ruling>"
//   evidence:
//     - { type: quote, ref: "..." }
//   options: ["accept as contract", "reject"]
//   recommendation: "<compiler's recommended option and why>"
//   entry: KN-NNNN            # optional — candidate entry awaiting ruling
//   source_observations: [OBS-...]
//
// Humans rule by editing the file: set `resolution: accepted|rejected` and
// optionally `resolution_note`. Resolved items stay in .kg/queue/ (history is
// the acceptance-rate metric input).

import fs from "node:fs";
import path from "node:path";
import { kyaml, host, protocol } from "./_lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdin") {
      if (out.stdin) host.fail("--stdin may be supplied only once");
      out.stdin = true;
      continue;
    }
    if (arg === "--now") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) host.fail("--now needs a value");
      if (out.now) host.fail("--now may be supplied only once");
      out.now = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) host.fail(`unknown option: ${arg}`);
    if (out.file) host.fail("only one queue draft file may be supplied");
    out.file = arg;
  }
  if (out.stdin && out.file) host.fail("--stdin and a draft file are mutually exclusive");
  if (!out.stdin && !out.file) host.fail("usage: add-queue-item.mjs <draft.yaml> | --stdin [--now <ISO>]");
  const now = out.now ? new Date(out.now) : new Date();
  if (Number.isNaN(now.getTime())) host.fail(`invalid --now timestamp: ${out.now}`);
  return { ...out, now };
}

function readInput(args) {
  if (args.stdin) return fs.readFileSync(0, "utf8");
  if (!fs.existsSync(args.file)) host.fail(`draft not found: ${args.file}`);
  return fs.readFileSync(args.file, "utf8");
}

const args = parseArgs(process.argv.slice(2));
const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
if (!fs.existsSync(paths.kg)) host.fail(`.kg/ not found under ${hostRoot} — run kg-init first`);
fs.mkdirSync(paths.queue, { recursive: true });

let draft;
try {
  draft = kyaml.parse(readInput(args));
} catch (err) {
  host.fail(`draft is not valid KYAML — ${err.message}`);
}

const routing = protocol.loadRouting();
const errors = [];
if (!["conflict", "promotion", "proposal"].includes(draft.kind)) {
  errors.push("kind: must be conflict | promotion | proposal");
}
if (!routing.categories?.[draft.category]) {
  errors.push(`category: \`${draft.category}\` is not in protocol/routing.yaml`);
}
if (typeof draft.claim !== "string" || draft.claim.trim() === "") errors.push("claim: required");
if (!Array.isArray(draft.evidence) || draft.evidence.length === 0) errors.push("evidence: at least one item required");
if (!Array.isArray(draft.options) || draft.options.length < 2) errors.push("options: give the human at least two options");
if (typeof draft.recommendation !== "string" || draft.recommendation.trim() === "") {
  errors.push("recommendation: required — never dump a decision on the human without a recommendation");
}
if (errors.length) {
  console.error(`kg: queue item rejected (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// Allocate Q-YYYYMMDD-NNN.
const day = args.now.toISOString().slice(0, 10).replaceAll("-", "");
let max = 0;
for (const f of host.listFiles(paths.queue, ".yaml")) {
  const m = new RegExp(`^Q-${day}-(\\d{3})\\.yaml$`).exec(path.basename(f));
  if (m) max = Math.max(max, Number.parseInt(m[1], 10));
}
const id = `Q-${day}-${String(max + 1).padStart(3, "0")}`;

const record = {
  id,
  at: args.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  kind: draft.kind,
  category: draft.category,
  claim: draft.claim,
  evidence: draft.evidence,
  options: draft.options,
  recommendation: draft.recommendation,
  entry: draft.entry ?? null,
  source_observations: draft.source_observations ?? [],
  resolution: "pending",
  resolution_note: null,
};

const outFile = path.join(paths.queue, `${id}.yaml`);
const temporary = path.join(paths.queue, `.${id}.kg-queue-write.tmp`);
try {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, kyaml.stringify(record), { flag: "wx" });
  fs.renameSync(temporary, outFile);
} finally {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
}
console.log(`kg: queued ${id} -> ${path.relative(process.cwd(), outFile) || outFile}`);
console.log("kg: list this item in the compile report's ruling checklist.");
