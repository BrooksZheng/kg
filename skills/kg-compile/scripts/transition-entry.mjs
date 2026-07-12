// Apply a lifecycle transition to a knowledge entry, machine-validated
// against protocol/lifecycle.yaml. Illegal transitions FAIL — that is the
// point of this script.
//
// Usage:
//   node skills/kg-compile/scripts/transition-entry.mjs <KN-id> <to-state> \
//     [--regret "<why the old knowledge was wrong / what it cost>"] \
//     [--superseded-by KN-NNNN]
//
// Rules enforced (from lifecycle.yaml):
//   - `to` must be reachable from the entry's current state;
//   - entering a state listed in regret_required_on_enter needs --regret;
//   - archiving from a state in archive_from_live_requires_reason needs
//     --superseded-by (merge — the surviving entry must exist, and its
//     `supersedes` back-pointer is written automatically) OR --regret
//     (direct retire).
// Demote/retire/merge actions are logged for the subtraction-ratio metric.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [idArg, toState] = positional;
if (!idArg || !toState) host.fail("usage: transition-entry.mjs <KN-id> <to-state> [--regret ...] [--superseded-by KN-NNNN]");

function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) host.fail(`${name} needs a value`);
  return v;
}
const regret = flagValue("--regret");
const supersededBy = flagValue("--superseded-by");

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
const lifecycle = protocol.loadLifecycle();
if (lifecycle.archive_from_live_requires_reason == null) {
  host.fail("protocol/lifecycle.yaml missing key `archive_from_live_requires_reason` — protocol files older than scripts?");
}

const files = host.listFiles(paths.knowledge, ".md");
const findEntry = (id) => files.find((f) => path.basename(f).startsWith(`${id}-`) || path.basename(f) === `${id}.md`);
const file = findEntry(idArg);
if (!file) host.fail(`no knowledge entry found for \`${idArg}\` in ${paths.knowledge}`);

const { frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
const from = frontmatter.lifecycle;

if (!lifecycle.states.includes(toState)) {
  host.fail(`\`${toState}\` is not a lifecycle state (${lifecycle.states.join(" | ")})`);
}
const allowed = (lifecycle.transitions[from] ?? "") === "" ? [] : lifecycle.transitions[from].split("|");
if (!allowed.includes(toState)) {
  host.fail(
    `illegal transition ${from} -> ${toState} for ${frontmatter.id}` +
      (allowed.length ? ` (legal: ${allowed.join(", ")})` : ` (\`${from}\` is terminal)`),
  );
}
if (lifecycle.regret_required_on_enter.includes(toState) && !(regret && regret.trim())) {
  host.fail(`transition to \`${toState}\` requires --regret "<reason>" — demotion without a recorded regret is forbidden`);
}
// ANY use of --superseded-by is a merge and goes through the same survivor
// machinery, regardless of the from-state (deprecated -> archived included).
let survivorFile = null;
if (supersededBy) {
  if (supersededBy === frontmatter.id) {
    host.fail(`--superseded-by must name a DIFFERENT entry — ${frontmatter.id} cannot supersede itself`);
  }
  survivorFile = findEntry(supersededBy);
  if (!survivorFile) host.fail(`surviving entry \`${supersededBy}\` not found in ${paths.knowledge}`);
}
if (
  toState === "archived" &&
  lifecycle.archive_from_live_requires_reason.includes(from) &&
  !supersededBy &&
  !(regret && regret.trim())
) {
  host.fail(
    `archiving a \`${from}\` entry needs a reason — pass --superseded-by <surviving KN-id> (merge) or --regret "<reason>" (retire)`,
  );
}

frontmatter.lifecycle = toState;
if (regret) frontmatter.regret = regret.trim();
if (supersededBy) frontmatter.superseded_by = supersededBy;
fs.writeFileSync(file, `---\n${kyaml.stringify(frontmatter)}---\n${body.startsWith("\n") ? body : "\n" + body}`);

// Merge back-pointer: the survivor records which entry it absorbed.
if (survivorFile) {
  const survivor = protocol.splitFrontmatter(fs.readFileSync(survivorFile, "utf8"));
  if (!survivor.frontmatter.supersedes) {
    survivor.frontmatter.supersedes = frontmatter.id;
    fs.writeFileSync(
      survivorFile,
      `---\n${kyaml.stringify(survivor.frontmatter)}---\n${survivor.body.startsWith("\n") ? survivor.body : "\n" + survivor.body}`,
    );
    console.log(`kg: ${supersededBy}: supersedes set to ${frontmatter.id}`);
  } else if (survivor.frontmatter.supersedes !== frontmatter.id) {
    console.log(
      `kg: WARNING — ${supersededBy} already supersedes ${survivor.frontmatter.supersedes}; record the additional merge of ${frontmatter.id} in the survivor's body`,
    );
  }
}

const action =
  toState === "deprecated" ? "demote"
  : toState === "archived" && supersededBy ? "merge"
  : toState === "archived" ? "retire"
  : toState === "active" ? "promote"
  : toState; // rejected / conflicted logged verbatim
host.appendRoundAction(paths, { action, entry: frontmatter.id, from, to: toState });

console.log(`kg: ${frontmatter.id}: ${from} -> ${toState}${regret ? " (regret recorded)" : ""}${supersededBy ? ` (superseded by ${supersededBy})` : ""}`);
if (["active", "deprecated", "archived", "rejected", "conflicted"].includes(toState)) {
  console.log("kg: re-render the AGENTS.md managed block (render-agents.mjs) before ending the session.");
}
