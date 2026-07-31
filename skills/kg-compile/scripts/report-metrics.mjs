// Compute the four MVP metrics (RFC D6) for the compile report:
//   1. repeat-correction count  — human corrections whose claim closely
//      matches an EARLIER human correction (token-Jaccard >= 0.6; heuristic,
//      the compiler agent must eyeball the flagged pairs)
//   2. candidate acceptance rate — accepted / (accepted + rejected) across
//      .kg/queue/ resolutions
//   3. knowledge regret log     — entries whose `regret` is non-null
//   4. subtraction ratio        — (merge + demote + retire) / add, from this
//      round's action log (written by add-entry / transition-entry)
//   5. staleness sweep          — live entries whose last_verified is older
//      than STALENESS_DAYS; flagged as retire/demote candidates so the
//      subtraction duty has a machine signal to answer with (Q-20260719-001,
//      option 1: no usage telemetry, ledger fields only)
//
// Usage:
//   node skills/kg-compile/scripts/report-metrics.mjs               # print block
//   node skills/kg-compile/scripts/report-metrics.mjs --now <ISO>   # fixed clock
//   node skills/kg-compile/scripts/report-metrics.mjs --clear-round # after the
//       report file is written, reset the round action log
//
// Output is a stable English markdown block to embed verbatim in the report;
// the surrounding report narrative follows the user's language.

import fs from "node:fs";
import { kyaml, protocol, host } from "./_lib.mjs";

const STALENESS_DAYS = 60;
const LIVE_LIFECYCLES = new Set(["candidate", "active", "conflicted"]);

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);

const nowIndex = process.argv.indexOf("--now");
let now = new Date();
if (nowIndex !== -1) {
  const value = process.argv[nowIndex + 1];
  if (!value || value.startsWith("--")) host.fail("--now needs an ISO timestamp value");
  now = new Date(value);
  if (Number.isNaN(now.getTime())) host.fail(`invalid --now timestamp: ${value}`);
}

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

const legalResolutions = protocol.loadRouting().queue_resolutions;
if (legalResolutions == null) {
  host.fail("protocol/routing.yaml missing key `queue_resolutions` — protocol files older than scripts?");
}
let accepted = 0;
let rejected = 0;
let pendingQueue = 0;
const badResolutions = [];
for (const file of host.listFiles(paths.queue, ".yaml")) {
  try {
    const item = kyaml.parse(fs.readFileSync(file, "utf8"));
    if (!legalResolutions.includes(item.resolution)) {
      badResolutions.push(`${item.id ?? file}: \`${item.resolution}\``);
      pendingQueue += 1;
    } else if (item.resolution === "accepted") accepted += 1;
    else if (item.resolution === "rejected") rejected += 1;
    else pendingQueue += 1;
  } catch {
    pendingQueue += 1;
  }
}
for (const bad of badResolutions) {
  console.error(`kg: WARNING — unrecognized queue resolution ${bad} (legal: ${legalResolutions.join(" | ")}); treated as pending — fix the file`);
}

// --- 3. regret log + 5. staleness sweep -----------------------------------------

const regrets = [];
const stale = [];
for (const file of host.listFiles(paths.knowledge, ".md")) {
  try {
    const { frontmatter } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
    if (frontmatter.regret) regrets.push({ id: frontmatter.id, lifecycle: frontmatter.lifecycle, regret: frontmatter.regret });
    if (LIVE_LIFECYCLES.has(frontmatter.lifecycle) && frontmatter.last_verified) {
      const verified = new Date(`${frontmatter.last_verified}T00:00:00Z`);
      if (!Number.isNaN(verified.getTime())) {
        const ageDays = Math.floor((now.getTime() - verified.getTime()) / 86_400_000);
        if (ageDays > STALENESS_DAYS) {
          stale.push({ id: frontmatter.id, lifecycle: frontmatter.lifecycle, ageDays });
        }
      }
    }
  } catch {
    // validate-knowledge.mjs owns entry validity.
  }
}
stale.sort((a, b) => b.ageDays - a.ageDays || String(a.id).localeCompare(String(b.id)));

// --- 4. subtraction ratio -------------------------------------------------------

const actions = host.readRoundActions(paths);
const count = (name) => actions.filter((a) => a.action === name).length;
const adds = count("add");
const subs = count("merge") + count("demote") + count("retire");

// --- render ----------------------------------------------------------------------

const lines = [
  "### kg metrics (machine-computed)",
  "",
  `- repeat-correction count (cumulative across all rounds, not new-this-round): ${repeatPairs.length}` +
    (repeatPairs.length
      ? ` — ${repeatPairs.map(([a, b]) => `${a}~${b}`).join(", ")} (heuristic match — verify before treating as a system failure)`
      : ""),
  `- candidate acceptance rate: ${accepted + rejected === 0 ? "n/a (no resolved queue items)" : `${accepted}/${accepted + rejected} accepted`}` +
    (pendingQueue ? ` — ${pendingQueue} still pending` : ""),
  regrets.length === 0 ? "- knowledge regret log: empty" : "- knowledge regret log:",
  ...regrets.map((r) => `  - ${r.id} (${r.lifecycle}): ${r.regret}`),
  `- subtraction ratio this round: ${subs}/${adds} (merge+demote+retire / add)` +
    (adds > 0 && subs === 0 ? " — additions without subtraction; state explicitly in the report why nothing could be merged or retired" : ""),
  stale.length === 0
    ? `- staleness sweep (last_verified older than ${STALENESS_DAYS} days, live entries): none`
    : `- staleness sweep (last_verified older than ${STALENESS_DAYS} days, live entries): ${stale.length} retire/demote candidate(s) — re-verify, update, or subtract each in this round's report:`,
  ...stale.map((s) => `  - ${s.id} (${s.lifecycle}): last verified ${s.ageDays} days ago`),
];
console.log(lines.join("\n"));
