// Record an `update` action in the round action log after hand-editing a
// knowledge entry (evidence / scope / last_verified / body — NEVER
// `lifecycle:`, which only transition-entry.mjs may change).
//
// Usage: node skills/kg-compile/scripts/log-update.mjs <KN-id> [<KN-id>...]
//
// Hand-editing is the sanctioned update mechanism, but an unlogged update is
// invisible to the compile report — every update must pass through here.

import path from "node:path";
import { host } from "./_lib.mjs";

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (ids.length === 0) host.fail("usage: log-update.mjs <KN-id> [<KN-id>...]");

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
const files = host.listFiles(paths.knowledge, ".md");

for (const id of ids) {
  if (!files.some((f) => path.basename(f).startsWith(`${id}-`) || path.basename(f) === `${id}.md`)) {
    host.fail(`no knowledge entry found for \`${id}\` in ${paths.knowledge}`);
  }
  host.appendRoundAction(paths, {
    action: "update",
    entry: id,
    actor: "human",
    provenance: "human_logged_update",
    update_scope: "full",
    body_action: "updated",
  });
  console.log(`kg: logged update of ${id}`);
}
console.log("kg: run validate-knowledge.mjs to confirm the edited entries still conform.");
