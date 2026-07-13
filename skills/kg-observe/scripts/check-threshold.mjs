// Report the pending-observation count against the compile threshold from
// .kg/config.yaml (observation_threshold). Prints a compile-session reminder
// when the threshold is reached or any fast_track observation is pending.
//
// Usage: node skills/kg-observe/scripts/check-threshold.mjs
// Exit code: 0 (informational — never blocks work).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { kyaml, host } from "./_lib.mjs";
import fs from "node:fs";

export function pendingStatus(hostRoot) {
  const paths = host.kgPaths(hostRoot);
  const config = host.loadConfig(hostRoot);
  const files = host.listFiles(paths.observations, ".yaml");
  let fastTrack = 0;
  for (const file of files) {
    try {
      if (kyaml.parse(fs.readFileSync(file, "utf8")).urgency === "fast_track") fastTrack += 1;
    } catch {
      // Malformed inbox files are counted as pending; kg-compile will flag them.
    }
  }
  return { pending: files.length, fastTrack, threshold: config.observation_threshold };
}

export function printStatus({ pending, fastTrack, threshold }) {
  console.log(`kg: pending observations: ${pending}/${threshold} (fast_track: ${fastTrack})`);
  if (fastTrack > 0) {
    console.log("kg: REMINDER — fast_track observation(s) pending: run an immediate kg-compile session.");
  } else if (pending >= threshold) {
    console.log("kg: REMINDER — threshold reached: a batch kg-compile session is due.");
  }
}

// Compare realpaths: Node ESM resolves import.meta.url through symlinks, so a
// symlink-installed skill (e.g. `npx skills add`, kg-init default mode) would
// otherwise never match argv[1] and silently skip the main entrypoint.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  printStatus(pendingStatus(host.findHostRoot()));
}
