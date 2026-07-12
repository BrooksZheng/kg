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
//   - archiving a live entry (merge) needs --superseded-by pointing at the
//     surviving entry, which must exist.
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
if (toState === "archived" && lifecycle.merge_requires_superseded_by.includes(from)) {
  if (!supersededBy) {
    host.fail(`archiving a \`${from}\` entry is a merge — pass --superseded-by <surviving KN-id>`);
  }
  if (!findEntry(supersededBy)) host.fail(`surviving entry \`${supersededBy}\` not found in ${paths.knowledge}`);
}

frontmatter.lifecycle = toState;
if (regret) frontmatter.regret = regret.trim();
if (supersededBy) frontmatter.superseded_by = supersededBy;
fs.writeFileSync(file, `---\n${kyaml.stringify(frontmatter)}---\n${body.startsWith("\n") ? body : "\n" + body}`);

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
