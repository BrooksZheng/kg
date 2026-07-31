// Shared-lib resolver. Works in both layouts:
//   plugin layout:   <plugin>/skills/<skill>/scripts/     ->  <plugin>/scripts/lib/
//   copied layout:   .agents/skills/<skill>/scripts/      ->  ./lib/  (kg-init copy
//                    mode embeds scripts/lib and protocol/ inside each skill dir)
import fs from "node:fs";

const here = new URL(".", import.meta.url);
const candidates = [new URL("../../../scripts/lib/", here), new URL("lib/", here)];
const libUrl = candidates.find((c) => fs.existsSync(new URL("kyaml.mjs", c)));
if (!libUrl) {
  console.error(
    "kg: error: cannot locate shared lib (expected ../../../scripts/lib/ or ./lib/).\n" +
      "  This skill copy is missing its embedded scripts/lib/ + protocol/ — it was\n" +
      "  installed from a kg version that predates self-contained skill dirs.\n" +
      "  Fix: reinstall from an up-to-date source, e.g.\n" +
      "    npx skills update   (or: npx skills add <kg-repo> again)",
  );
  process.exit(1);
}

export const kyaml = await import(new URL("kyaml.mjs", libUrl).href);
export const protocol = await import(new URL("protocol.mjs", libUrl).href);
export const host = await import(new URL("host.mjs", libUrl).href);
export const documentAnchor = await import(new URL("document-anchor.mjs", libUrl).href);
export const repository = await import(new URL("repository.mjs", libUrl).href);
