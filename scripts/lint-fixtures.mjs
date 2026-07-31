// Validate every stable line anchor reachable from a public evaluator fixture.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./lib/kyaml.mjs";
import * as documentAnchor from "./lib/document-anchor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".yaml", ".yml"]);

function fail(message) {
  console.error(`kg: error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) return { root: path.join(ROOT, "scripts", "fixtures") };
  if (argv.length !== 2 || argv[0] !== "--root") fail("usage: node scripts/lint-fixtures.mjs [--root <fixtures-root>]");
  return { root: path.resolve(argv[1]) };
}

function walkFiles(root) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || entry.name.toLowerCase() === ".kg") continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  walk(root);
  return files;
}

function readMachine(file) {
  const content = fs.readFileSync(file, "utf8");
  try {
    return path.extname(file).toLowerCase() === ".json" ? JSON.parse(content) : parse(content);
  } catch {
    return null;
  }
}

function repoPath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
}

function addMapping(mappings, scopeValue, projectValue) {
  const scope = repoPath(scopeValue);
  const project = repoPath(projectValue);
  if (scope && project && fs.existsSync(scope) && fs.existsSync(project)) mappings.push({ scope, project });
}

function fixtureMappings(files) {
  const mappings = [];
  for (const file of files) {
    if (![".json", ".yaml", ".yml"].includes(path.extname(file).toLowerCase())) continue;
    const fixture = readMachine(file);
    if (fixture?.kind === "kg.eval_compile_fixture") {
      addMapping(mappings, fixture.project_source, fixture.project_source);
    }
    if (fixture?.kind === "kg.eval_kickoff_fixture") {
      addMapping(mappings, fixture.project_root, fixture.project_root);
      addMapping(mappings, fixture.transcript, fixture.project_root);
      addMapping(mappings, fixture.artifacts_root, fixture.project_root);
    }
    if (fixture?.kind === "kg.eval_spec_fixture") {
      addMapping(mappings, fixture.project_root, fixture.project_root);
      for (const field of [
        "kickoff_response",
        "kickoff_artifacts_root",
        "spec_response",
        "spec_artifacts_root",
        "transcript",
        "synthesis",
        "expected_spec",
      ]) {
        addMapping(mappings, fixture[field], fixture.project_root);
      }
    }
  }
  return mappings;
}

function mappingFor(file, mappings) {
  const matches = mappings.filter(({ scope }) => file === scope || file.startsWith(`${scope}${path.sep}`));
  matches.sort((left, right) => right.scope.length - left.scope.length);
  return matches[0] ?? null;
}

function validateAnchors(files, mappings) {
  const errors = [];
  let anchors = 0;
  let mappedFiles = 0;
  const pattern = /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?/g;
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const mapping = mappingFor(file, mappings);
    if (!mapping) continue;
    mappedFiles += 1;
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(pattern)) {
      anchors += 1;
      const sourcePath = match[1];
      const line = Number.parseInt(match[2], 10);
      const lineEnd = match[3] === undefined ? line : Number.parseInt(match[3], 10);
      try {
        if (lineEnd < line) throw new Error(`line range ends before it starts: ${lineEnd} < ${line}`);
        documentAnchor.validateStableDocumentReference({
          sourcePath,
          line,
          projectRoot: mapping.project,
        });
        if (lineEnd !== line) {
          documentAnchor.validateStableDocumentReference({
            sourcePath,
            line: lineEnd,
            projectRoot: mapping.project,
          });
        }
      } catch (error) {
        errors.push(`${path.relative(ROOT, file)}: ${match[0]}: ${error.message}`);
      }
    }
  }
  return { errors, anchors, mappedFiles };
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) fail(`fixture root is not a directory: ${args.root}`);
const files = walkFiles(args.root);
const result = validateAnchors(files, fixtureMappings(files));
if (result.errors.length > 0) fail(`fixture source ref lint failed:\n${result.errors.join("\n")}`);
console.log(`kg: fixture source refs valid (${result.anchors} anchors across ${result.mappedFiles} mapped files)`);
