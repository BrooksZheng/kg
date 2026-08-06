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

function readInput() {
  const args = process.argv.slice(2);
  if (args.includes("--stdin")) return fs.readFileSync(0, "utf8");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) host.fail("usage: add-queue-item.mjs <draft.yaml> | --stdin");
  if (!fs.existsSync(file)) host.fail(`draft not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
if (!fs.existsSync(paths.kg)) host.fail(`.kg/ not found under ${hostRoot} — run kg-init first`);
fs.mkdirSync(paths.queue, { recursive: true });

let draft;
try {
  draft = kyaml.parse(readInput());
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
const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
let max = 0;
for (const f of host.listFiles(paths.queue, ".yaml")) {
  const m = new RegExp(`^Q-${day}-(\\d{3})\\.yaml$`).exec(path.basename(f));
  if (m) max = Math.max(max, Number.parseInt(m[1], 10));
}
const id = `Q-${day}-${String(max + 1).padStart(3, "0")}`;

const record = {
  id,
  at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
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
fs.writeFileSync(outFile, kyaml.stringify(record));
console.log(`kg: queued ${id} -> ${path.relative(process.cwd(), outFile) || outFile}`);
console.log("kg: list this item in the compile report's ruling checklist.");
