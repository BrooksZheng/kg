// Create a new knowledge entry from a draft markdown file (frontmatter+body),
// enforcing the routing table's tiered autonomy:
//   - project_knowledge / procedure  -> created with lifecycle: active
//   - project_contract / executable_constraint -> lifecycle: candidate, and
//     you MUST also file a .kg/queue/ item (add-queue-item.mjs) for the ruling
//
// Usage: node skills/kg-compile/scripts/add-entry.mjs <draft.md>
//
// Draft frontmatter may omit id (assigned), lifecycle (derived from routing),
// last_verified (today), supersedes/regret (null). The write is logged to the
// round action log for the subtraction-ratio metric.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

const draftFile = process.argv[2];
if (!draftFile) host.fail("usage: add-entry.mjs <draft.md>");
if (!fs.existsSync(draftFile)) host.fail(`draft not found: ${draftFile}`);

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);
if (!fs.existsSync(paths.kg)) host.fail(`.kg/ not found under ${hostRoot} — run kg-init first`);
fs.mkdirSync(paths.knowledge, { recursive: true });

let frontmatter, body;
try {
  ({ frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(draftFile, "utf8")));
} catch (err) {
  host.fail(`draft parse failed — ${err.message}`);
}

// Reject unknown draft fields up front — otherwise a typo (`confidnce:`)
// would be silently dropped by the canonical rebuild below and surface only
// as a misleading "required field is missing" error.
const knowledgeSchema = protocol.loadKnowledgeSchema();
const knownFields = new Set(Object.keys(knowledgeSchema.fields).map((p) => p.split(/[.\[]/)[0]));
const unknown = Object.keys(frontmatter).filter((k) => !knownFields.has(k));
if (unknown.length) {
  host.fail(`unknown draft field(s): ${unknown.join(", ")} — typo? (schema: protocol/knowledge.schema.yaml)`);
}
// New entries always start with these null; they are only settable through
// transition-entry.mjs. Rejecting (instead of silently nulling) makes the
// canonical rebuild below lossless.
for (const f of ["regret", "superseded_by"]) {
  if (frontmatter[f] !== undefined && frontmatter[f] !== null) {
    host.fail(`draft sets \`${f}\` — this field is only settable via transition-entry.mjs; new entries start with it null`);
  }
}

const routing = protocol.loadRouting();
const category = frontmatter.category;
const route = routing.categories?.[category];
if (!route) host.fail(`category \`${category}\` is not in protocol/routing.yaml`);
if (route.autonomy === "human") {
  host.fail(`category \`${category}\` produces queue items only — use add-queue-item.mjs, not a knowledge entry`);
}

const id = frontmatter.id && frontmatter.id !== "auto" ? frontmatter.id : host.nextKnowledgeId(paths);
const derivedLifecycle = route.autonomy === "auto" ? "active" : "candidate";
if (frontmatter.lifecycle && frontmatter.lifecycle !== derivedLifecycle) {
  host.fail(
    `draft sets lifecycle \`${frontmatter.lifecycle}\` but routing autonomy \`${route.autonomy}\` requires \`${derivedLifecycle}\``,
  );
}

const record = {
  id,
  claim: frontmatter.claim,
  category,
  scope: frontmatter.scope ?? {},
  evidence: frontmatter.evidence,
  authority: frontmatter.authority,
  confidence: frontmatter.confidence,
  lifecycle: derivedLifecycle,
  supersedes: frontmatter.supersedes ?? null,
  last_verified: frontmatter.last_verified ?? new Date().toISOString().slice(0, 10),
  regret: null,
  source_obs_ids: frontmatter.source_obs_ids ?? [],
  carrier_refs: frontmatter.carrier_refs ?? [],
};

const errors = protocol.validateRecord(record, knowledgeSchema);
if (errors.length) {
  console.error(`kg: entry rejected (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (body.trim() === "") host.fail("entry body is empty — write the explanation, the entry IS the reference doc");

const outFile = path.join(paths.knowledge, host.knowledgeFilename(id, record.claim));
if (fs.existsSync(outFile)) host.fail(`refusing to overwrite ${outFile}`);
const temporary = path.join(paths.knowledge, `.${path.basename(outFile)}.kg-entry-write.tmp`);
try {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, `---\n${kyaml.stringify(record)}---\n\n${body.trim()}\n`, { flag: "wx" });
  fs.renameSync(temporary, outFile);
} finally {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
}
host.appendRoundAction(paths, { action: "add", entry: id, category, lifecycle: derivedLifecycle });

console.log(`kg: created ${id} (${derivedLifecycle}) -> ${path.relative(process.cwd(), outFile) || outFile}`);
if (derivedLifecycle === "candidate") {
  console.log(`kg: category \`${category}\` is human_review — file a queue item now (add-queue-item.mjs) and do NOT activate without a human ruling.`);
} else {
  console.log("kg: entry is active; validate knowledge and continue the compile report.");
}
