// Shared-lib resolver. Works in both layouts:
//   plugin layout:   <plugin>/skills/kg-observe/scripts/  ->  <plugin>/scripts/lib/
//   copied layout:   .agents/skills/kg-observe/scripts/   ->  ./lib/  (kg-init copy
//                    mode places scripts/lib and protocol/ inside the skill dir)
import fs from "node:fs";

const here = new URL(".", import.meta.url);
const candidates = [new URL("../../../scripts/lib/", here), new URL("lib/", here)];
const libUrl = candidates.find((c) => fs.existsSync(new URL("kyaml.mjs", c)));
if (!libUrl) {
  console.error("kg: error: cannot locate shared lib (expected ../../../scripts/lib/ or ./lib/)");
  process.exit(1);
}

export const kyaml = await import(new URL("kyaml.mjs", libUrl).href);
export const protocol = await import(new URL("protocol.mjs", libUrl).href);
export const host = await import(new URL("host.mjs", libUrl).href);
