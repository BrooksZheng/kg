// Create a canonical processed observation with its compile-owned KN
// writeback, then remove the untouched pending original.
//
// Usage:
//   node archive-observations.mjs --observation OBS-... --compiled-to-kn KN-...
//
// All predictable errors are checked before mutation. The referenced
// knowledge entry must exist and pass the knowledge schema.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--observation", "--compiled-to-kn"].includes(arg)) host.fail(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) host.fail(`${arg} needs a value`);
    const key = arg === "--observation" ? "observation" : "compiledToKn";
    if (out[key]) host.fail(`${arg} may be supplied only once`);
    out[key] = value;
    index += 1;
  }
  if (!out.observation || !out.compiledToKn) {
    host.fail("usage: archive-observations.mjs --observation OBS-... --compiled-to-kn KN-...");
  }
  return out;
}

function canonicalObservation(record) {
  return {
    id: record.id,
    at: record.at,
    source: record.source,
    claim: record.claim,
    context: record.context,
    evidence: record.evidence,
    urgency: record.urgency,
    compiled_to_kn: record.compiled_to_kn,
  };
}

function findKnowledgeEntry(knowledgeDir, id) {
  const matches = host
    .listFiles(knowledgeDir, ".md")
    .filter((file) => path.basename(file) === `${id}.md` || path.basename(file).startsWith(`${id}-`));
  if (matches.length !== 1) {
    host.fail(
      matches.length === 0
        ? `knowledge entry not found: ${id}`
        : `knowledge id ${id} resolves to multiple files: ${matches.map((file) => path.basename(file)).join(", ")}`,
    );
  }
  const file = matches[0];
  if (fs.lstatSync(file).isSymbolicLink()) host.fail(`knowledge entry must not be a symbolic link: ${file}`);
  let frontmatter, body;
  try {
    ({ frontmatter, body } = protocol.splitFrontmatter(fs.readFileSync(file, "utf8")));
  } catch (error) {
    host.fail(`knowledge entry parse failed for ${id}: ${error.message}`);
  }
  const errors = protocol.validateRecord(frontmatter, protocol.loadKnowledgeSchema());
  if (frontmatter.id !== id) errors.push(`knowledge frontmatter id must equal ${id}`);
  if (body.trim() === "") errors.push("knowledge body is empty");
  if (errors.length) host.fail(`knowledge entry ${id} is invalid: ${errors.join("; ")}`);
  return file;
}

const args = parseArgs(process.argv.slice(2));
if (!/^OBS-[0-9]{8}-[0-9]{3}$/.test(args.observation)) host.fail(`invalid observation id: ${args.observation}`);
if (!/^KN-[0-9]{4}$/.test(args.compiledToKn)) host.fail(`invalid compiled_to_kn: ${args.compiledToKn}`);

let hostRoot;
try {
  hostRoot = host.assertSafeHostRoot(host.findHostRoot());
} catch (error) {
  host.fail(error.message);
}
const paths = host.kgPaths(hostRoot);
const source = path.join(paths.observations, `${args.observation}.yaml`);
const destination = path.join(paths.processed, `${args.observation}.yaml`);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  host.fail(`observation not found in inbox: ${args.observation}`);
}
if (fs.existsSync(destination)) host.fail(`already archived: ${path.basename(destination)}`);

findKnowledgeEntry(paths.knowledge, args.compiledToKn);

let observation;
try {
  observation = kyaml.parse(fs.readFileSync(source, "utf8"));
} catch (error) {
  host.fail(`observation parse failed: ${error.message}`);
}
const inputErrors = protocol.validateRecord(observation, protocol.loadObservationSchema());
if (observation.id !== args.observation) inputErrors.push(`observation id must equal ${args.observation}`);
if (observation.compiled_to_kn !== undefined && observation.compiled_to_kn !== null) {
  inputErrors.push("pending observation already has compiled_to_kn");
}
if (inputErrors.length) host.fail(`observation is invalid: ${inputErrors.join("; ")}`);

const processed = canonicalObservation({ ...observation, compiled_to_kn: args.compiledToKn });
const outputErrors = protocol.validateRecord(processed, protocol.loadObservationSchema());
if (outputErrors.length) host.fail(`processed observation would be invalid: ${outputErrors.join("; ")}`);

fs.mkdirSync(paths.processed, { recursive: true });
const temporary = path.join(paths.processed, `.${args.observation}.${process.pid}.tmp`);
let destinationCreated = false;
try {
  fs.writeFileSync(temporary, kyaml.stringify(processed), { flag: "wx" });
  fs.renameSync(temporary, destination);
  destinationCreated = true;
  fs.unlinkSync(source);
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  if (destinationCreated) fs.rmSync(destination, { force: true });
  throw error;
}
console.log(`kg: archived ${args.observation} with compiled_to_kn ${args.compiledToKn}`);
