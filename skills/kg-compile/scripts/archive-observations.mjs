// Create a canonical processed observation, optionally with its compile-owned
// KN writeback, then remove the untouched pending original.
//
// Usage:
//   node archive-observations.mjs --observation OBS-... --compiled-to-kn KN-...
//   node archive-observations.mjs --observation OBS-... --verdict <routing-verdict>
//
// Exactly one archive result is required. All predictable errors are checked
// before mutation. A referenced knowledge entry must exist and pass the
// knowledge schema. No-KN verdicts are loaded from protocol/routing.yaml.

import fs from "node:fs";
import path from "node:path";
import { kyaml, protocol, host } from "./_lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--observation", "--compiled-to-kn", "--verdict"].includes(arg)) host.fail(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) host.fail(`${arg} needs a value`);
    const key =
      arg === "--observation" ? "observation"
      : arg === "--compiled-to-kn" ? "compiledToKn"
      : "verdict";
    if (out[key]) host.fail(`${arg} may be supplied only once`);
    out[key] = value;
    index += 1;
  }
  if (!out.observation) {
    host.fail(
      "usage: archive-observations.mjs --observation OBS-... (--compiled-to-kn KN-... | --verdict <routing-verdict>)",
    );
  }
  if (out.compiledToKn && out.verdict) {
    host.fail("--compiled-to-kn and --verdict are mutually exclusive");
  }
  if (!out.compiledToKn && !out.verdict) {
    host.fail("exactly one of --compiled-to-kn or --verdict is required");
  }
  return out;
}

function canonicalObservation(record, compiledToKn) {
  const canonical = {
    id: record.id,
    at: record.at,
    source: record.source,
    claim: record.claim,
    context: record.context,
    evidence: record.evidence,
    urgency: record.urgency,
  };
  if (compiledToKn !== undefined) canonical.compiled_to_kn = compiledToKn;
  return canonical;
}

function loadNoKnowledgeVerdicts() {
  let routing;
  try {
    routing = protocol.loadRouting();
  } catch (error) {
    host.fail(`routing protocol could not be loaded: ${error.message}`);
  }
  if (!Array.isArray(routing.verdicts) || !routing.verdicts.every((value) => typeof value === "string" && value)) {
    host.fail("protocol/routing.yaml verdicts must be a list of non-empty strings");
  }
  if (routing.categories === null || typeof routing.categories !== "object" || Array.isArray(routing.categories)) {
    host.fail("protocol/routing.yaml categories must be a mapping");
  }
  const humanCategories = Object.entries(routing.categories)
    .filter(([, route]) => route?.autonomy === "human")
    .map(([category]) => category);
  return new Set([...routing.verdicts, ...humanCategories]);
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
if (args.compiledToKn && !/^KN-[0-9]{4}$/.test(args.compiledToKn)) {
  host.fail(`invalid compiled_to_kn: ${args.compiledToKn}`);
}
if (args.verdict) {
  const allowedVerdicts = loadNoKnowledgeVerdicts();
  if (!allowedVerdicts.has(args.verdict)) {
    host.fail(`invalid no-knowledge verdict: ${args.verdict} (allowed: ${[...allowedVerdicts].join(" | ")})`);
  }
}

let hostRoot;
try {
  hostRoot = host.assertSafeHostRoot(host.findHostRoot());
} catch (error) {
  host.fail(error.message);
}
const paths = host.kgPaths(hostRoot);
const source = path.join(paths.observations, `${args.observation}.yaml`);
const destination = path.join(paths.processed, `${args.observation}.yaml`);
if (args.compiledToKn) findKnowledgeEntry(paths.knowledge, args.compiledToKn);

function parseObservationFile(file, label) {
  let record;
  try {
    record = kyaml.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    host.fail(`${label} observation parse failed: ${error.message}`);
  }
  const errors = protocol.validateRecord(record, protocol.loadObservationSchema());
  if (record.id !== args.observation) errors.push(`observation id must equal ${args.observation}`);
  if (errors.length) host.fail(`${label} observation is invalid: ${errors.join("; ")}`);
  return record;
}

if (fs.existsSync(destination)) {
  if (!fs.statSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink()) {
    host.fail(`processed observation target is not a regular file: ${destination}`);
  }
  const processed = parseObservationFile(destination, "processed");
  if (args.compiledToKn && processed.compiled_to_kn !== args.compiledToKn) {
    host.fail(
      `already archived with different compiled_to_kn: ${processed.compiled_to_kn ?? "none"} (expected ${args.compiledToKn})`,
    );
  }
  if (args.verdict && processed.compiled_to_kn !== undefined && processed.compiled_to_kn !== null) {
    host.fail(`already archived with compiled_to_kn, cannot apply verdict ${args.verdict}`);
  }
  if (fs.existsSync(source)) {
    if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) {
      host.fail(`pending observation source is not a regular file: ${source}`);
    }
    const pending = parseObservationFile(source, "pending");
    if (pending.compiled_to_kn !== undefined && pending.compiled_to_kn !== null) {
      host.fail("pending observation already has compiled_to_kn");
    }
    const expected = canonicalObservation(pending, args.compiledToKn);
    if (kyaml.stringify(expected) !== kyaml.stringify(processed)) {
      host.fail(`processed observation differs from pending source: ${args.observation}`);
    }
    fs.unlinkSync(source);
  }
  console.log(
    args.compiledToKn
      ? `kg: already archived ${args.observation} with compiled_to_kn ${args.compiledToKn}`
      : `kg: already archived ${args.observation} with verdict ${args.verdict}`,
  );
  process.exit(0);
}
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  host.fail(`observation not found in inbox: ${args.observation}`);
}
if (fs.lstatSync(source).isSymbolicLink()) host.fail(`pending observation must not be a symbolic link: ${source}`);

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

const processed = canonicalObservation(observation, args.compiledToKn);
const outputErrors = protocol.validateRecord(processed, protocol.loadObservationSchema());
if (outputErrors.length) host.fail(`processed observation would be invalid: ${outputErrors.join("; ")}`);

fs.mkdirSync(paths.processed, { recursive: true });
const temporary = path.join(paths.processed, `.${args.observation}.kg-archive-write.tmp`);
let destinationCreated = false;
try {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, kyaml.stringify(processed), { flag: "wx" });
  fs.renameSync(temporary, destination);
  destinationCreated = true;
  fs.unlinkSync(source);
} catch (error) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  if (destinationCreated) fs.rmSync(destination, { force: true });
  throw error;
}
console.log(
  args.compiledToKn
    ? `kg: archived ${args.observation} with compiled_to_kn ${args.compiledToKn}`
    : `kg: archived ${args.observation} with verdict ${args.verdict}`,
);
