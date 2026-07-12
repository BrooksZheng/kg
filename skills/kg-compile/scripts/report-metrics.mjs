// Compute the four MVP metrics (RFC D6) for the compile report:
//   1. repeat-correction count  — human corrections whose claim closely
//      matches an EARLIER human correction (token-Jaccard >= 0.6; heuristic,
//      the compiler agent must eyeball the flagged pairs)
//   2. candidate acceptance rate — accepted / (accepted + rejected) across
//      .kg/queue/ resolutions
//   3. knowledge regret log     — entries whose `regret` is non-null
//   4. subtraction ratio        — (merge + demote + retire) / add, from this
//      round's action log (written by add-entry / transition-entry)
//
// Usage:
//   node skills/kg-compile/scripts/report-metrics.mjs               # print block
//   node skills/kg-compile/scripts/report-metrics.mjs --clear-round # after the
//       report file is written, reset the round action log
//
// Output is a stable English markdown block to embed verbatim in the report;
// the surrounding report narrative follows the user's language.

import fs from "node:fs";
import { kyaml, protocol, host } from "./_lib.mjs";

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);

if (process.argv.includes("--clear-round")) {
  const file = host.roundLogFile(paths);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log("kg: round action log cleared — next compile round starts fresh.");
  process.exit(0);
}

// --- 1. repeat corrections ---------------------------------------------------

const tokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
};

const corrections = [];
for (const dir of [paths.processed, paths.observations]) {
  for (const file of host.listFiles(dir, ".yaml")) {
    try {
      const obs = kyaml.parse(fs.readFileSync(file, "utf8"));
      if (obs.source === "human_correction") corrections.push(obs);
    } catch {
      // Malformed files are validate-observations' problem, not the metrics'.
    }
  }
}
corrections.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const repeatPairs = [];
for (let i = 0; i < corrections.length; i++) {
  for (let j = i + 1; j < corrections.length; j++) {
    if (jaccard(tokens(corrections[i].claim), tokens(corrections[j].claim)) >= 0.6) {
      repeatPairs.push([corrections[i].id, corrections[j].id]);
    }
  }
}

// --- 2. candidate acceptance rate ---------------------------------------------

let accepted = 0;
let rejected = 0;
let pendingQueue = 0;
for (const file of host.listFiles(paths.queue, ".yaml")) {
  try {
    const item = kyaml.parse(fs.readFileSync(file, "utf8"));
    if (item.resolution === "accepted") accepted += 1;
    else if (item.resolution === "rejected") rejected += 1;
    else pendingQueue += 1;
  } catch {
    pendingQueue += 1;
  }
}

// --- 3. regret log --------------------------------------------------------------

const regrets = [];
for (const file of host.listFiles(paths.knowledge, ".md")) {
  try {
    const { frontmatter } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
    if (frontmatter.regret) regrets.push({ id: frontmatter.id, lifecycle: frontmatter.lifecycle, regret: frontmatter.regret });
  } catch {
    // validate-knowledge.mjs owns entry validity.
  }
}

// --- 4. subtraction ratio -------------------------------------------------------

const actions = host.readRoundActions(paths);
const count = (name) => actions.filter((a) => a.action === name).length;
const adds = count("add");
const subs = count("merge") + count("demote") + count("retire");

// --- render ----------------------------------------------------------------------

const lines = [
  "### kg metrics (machine-computed)",
  "",
  `- repeat-correction count: ${repeatPairs.length}` +
    (repeatPairs.length
      ? ` — ${repeatPairs.map(([a, b]) => `${a}~${b}`).join(", ")} (heuristic match — verify before treating as a system failure)`
      : ""),
  `- candidate acceptance rate: ${accepted + rejected === 0 ? "n/a (no resolved queue items)" : `${accepted}/${accepted + rejected} accepted`}` +
    (pendingQueue ? ` — ${pendingQueue} still pending` : ""),
  regrets.length === 0 ? "- knowledge regret log: empty" : "- knowledge regret log:",
  ...regrets.map((r) => `  - ${r.id} (${r.lifecycle}): ${r.regret}`),
  `- subtraction ratio this round: ${subs}/${adds || 0} (merge+demote+retire / add)` +
    (adds > 0 && subs === 0 ? " — additions without subtraction; state explicitly in the report why nothing could be merged or retired" : ""),
];
console.log(lines.filter((l) => l !== null).join("\n"));
