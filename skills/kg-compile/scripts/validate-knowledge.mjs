// Validate knowledge entry frontmatter against protocol/knowledge.schema.yaml.
//
// Usage:
//   node skills/kg-compile/scripts/validate-knowledge.mjs            # all knowledge/*.md
//   node skills/kg-compile/scripts/validate-knowledge.mjs <file>...  # specific files
//
// Beyond the schema: filename must match `KN-NNNN-<slug>.md` and embed the
// entry id; lifecycle-dependent invariants (regret on deprecated,
// superseded_by consistency) are checked here too. Exits 1 on any failure.

import fs from "node:fs";
import path from "node:path";
import { protocol, host } from "./_lib.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
const files = args.length ? args : host.listFiles(paths.knowledge, ".md");

if (files.length === 0) {
  console.log("kg: no knowledge entries to validate.");
  process.exit(0);
}

const schema = protocol.loadKnowledgeSchema();
let bad = 0;
for (const file of files) {
  const label = path.relative(process.cwd(), file) || file;
  let errors = [];
  try {
    const { frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8"));
    errors = protocol.validateRecord(frontmatter, schema);
    const base = path.basename(file);
    if (frontmatter.id && !new RegExp(`^${frontmatter.id}(-[a-z0-9-]+)?\\.md$`).test(base)) {
      errors.push(`filename \`${base}\` must start with entry id \`${frontmatter.id}\``);
    }
    if (frontmatter.lifecycle === "deprecated" && !frontmatter.regret) {
      errors.push("lifecycle is `deprecated` but `regret` is null — demotion requires a regret reason");
    }
    if (frontmatter.superseded_by && !["archived", "deprecated"].includes(frontmatter.lifecycle)) {
      errors.push("`superseded_by` is set but entry is still live — merge losers must be archived/deprecated");
    }
    if (body.trim() === "") {
      errors.push("entry body is empty — the entry IS the reference doc; write the explanation");
    }
    if (frontmatter.scope?.domains) {
      errors.push(...protocol.validateScopeDomains(frontmatter.scope.domains));
    }
  } catch (err) {
    errors = [err.message];
  }
  if (errors.length) {
    bad += 1;
    console.error(`FAIL ${label}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

console.log(`kg: ${files.length - bad}/${files.length} knowledge entr${files.length === 1 ? "y" : "ies"} valid`);
process.exit(bad ? 1 : 0);
