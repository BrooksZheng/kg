// Split evaluator fixture loader. Scenario data is agent-visible; oracle data
// stays hidden. Version 2 saved fixtures remain readable through the same entry.

import fs from "node:fs";
import path from "node:path";
import { parse } from "./kyaml.mjs";
import * as host from "./host.mjs";
import * as protocol from "./protocol.mjs";
import { canonicalizeRecord, sha256File } from "./machine-contract.mjs";

function readMachine(file) {
  const content = fs.readFileSync(file, "utf8");
  return path.extname(file).toLowerCase() === ".json" || content.trimStart().startsWith("{")
    ? JSON.parse(content)
    : parse(content);
}

function requireFile(value, label) {
  const declared = path.resolve(value);
  if (host.hasPathSegment(declared, ".kg")) throw new Error(`${label} must not enter .kg`);
  if (!fs.existsSync(declared) || !fs.statSync(declared).isFile()) throw new Error(`${label} is not a file: ${declared}`);
  if (fs.lstatSync(declared).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return host.canonicalPath(declared);
}

function fixturePath(fixtureRoot, value, label, { mustExist = true } = {}) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    throw new Error(`${label} must be a fixture-relative path`);
  }
  const resolved = host.resolveSafeRelative(fixtureRoot, value, { mustExist, forbidKg: true });
  return resolved;
}

function contains(root, target) {
  return root === target || !host.isOutside(root, target);
}

function validateScenarioPaths(scenario, fixtureRoot) {
  const sourceRoots = scenario.source_roots.map((value, index) => {
    const resolved = fixturePath(fixtureRoot, value, `source_roots[${index}]`);
    return resolved.canonical;
  });
  const judgedArtifactRoots = scenario.judged_artifact_roots.map((value, index) => {
    const resolved = fixturePath(fixtureRoot, value, `judged_artifact_roots[${index}]`, { mustExist: false });
    return resolved.canonical;
  });
  for (const [index, value] of scenario.visible_inputs.entries()) {
    fixturePath(fixtureRoot, value, `visible_inputs[${index}]`);
  }
  return { sourceRoots, judgedArtifactRoots };
}

function derivationPointer(expectation, fixtureRoot, pathPolicy) {
  // KN-0035: hard oracle values must point to independently readable fixture
  // source bytes and may never derive from the oracle or judged products.
  if (expectation.derivation === undefined) return null;
  const match = /^(.*)#L([1-9][0-9]*)$/.exec(expectation.derivation);
  if (!match) throw new Error(`${expectation.expectation_id}: derivation must be fixture/path#L<number>`);
  const resolved = fixturePath(fixtureRoot, match[1], `${expectation.expectation_id}.derivation`);
  if (pathPolicy.forbiddenDerivationFiles.has(resolved.canonical)) {
    throw new Error(`${expectation.expectation_id}: derivation points into the oracle itself`);
  }
  if (!pathPolicy.sourceRoots.some((root) => contains(root, resolved.canonical))) {
    throw new Error(`${expectation.expectation_id}: derivation points outside scenario source_roots`);
  }
  if (pathPolicy.judgedArtifactRoots.some((root) => contains(root, resolved.canonical))) {
    throw new Error(`${expectation.expectation_id}: derivation points into judged artifacts`);
  }
  if (!fs.statSync(resolved.full).isFile()) {
    throw new Error(`${expectation.expectation_id}: derivation path is not a source file`);
  }
  const line = Number.parseInt(match[2], 10);
  const lines = fs.readFileSync(resolved.full, "utf8").split(/\r?\n/);
  if (line > lines.length) throw new Error(`${expectation.expectation_id}: derivation line ${line} is out of range`);
  return { path: resolved.relative, line, sha256: sha256File(resolved.full) };
}

export function loadSavedEvaluationFixture(file, expectedKind, acceptedVersions = [2]) {
  const fixtureFile = requireFile(file, "fixture");
  const fixture = readMachine(fixtureFile);
  if (fixture?.kind !== expectedKind || !acceptedVersions.includes(fixture?.version)) {
    throw new Error(`saved fixture must be ${expectedKind} version ${acceptedVersions.join(" or ")}`);
  }
  return { format: `legacy-v${fixture.version}`, fixture, fixtureFile };
}

export function loadSplitEvaluationFixture({ scenarioFile, oracleFile }) {
  const scenarioPath = requireFile(scenarioFile, "scenario");
  const oraclePath = requireFile(oracleFile, "oracle");
  const fixtureRoot = host.canonicalPath(path.dirname(scenarioPath));
  if (host.isOutside(fixtureRoot, oraclePath)) throw new Error("oracle must stay inside the fixture root");

  const scenario = canonicalizeRecord(
    readMachine(scenarioPath),
    protocol.loadProtocolFile("evaluation-scenario.schema.yaml"),
    "evaluation scenario",
  );
  const oracle = canonicalizeRecord(
    readMachine(oraclePath),
    protocol.loadProtocolFile("evaluation-oracle.schema.yaml"),
    "evaluation oracle",
  );
  if (scenario.fixture_id !== oracle.fixture_id || scenario.evaluator !== oracle.evaluator) {
    throw new Error("scenario and oracle fixture identity must match");
  }

  const rubric = protocol.loadProtocolFile("evaluation-rubric.schema.yaml");
  if (!rubric.evaluator_values.includes(scenario.evaluator)) {
    throw new Error(`unknown evaluator: ${scenario.evaluator}`);
  }
  const levels = new Set(rubric.expectation_level_values);
  const criteria = new Set(Object.keys(rubric.criteria));
  const pathPolicy = validateScenarioPaths(scenario, fixtureRoot);
  pathPolicy.forbiddenDerivationFiles = new Set([oraclePath]);
  const hardExpectations = [];
  const advisoryExpectations = [];
  for (const expectation of oracle.expectations) {
    if (!levels.has(expectation.level)) throw new Error(`${expectation.expectation_id}: unknown expectation level`);
    if (expectation.criterion_id !== null && !criteria.has(expectation.criterion_id)) {
      throw new Error(`${expectation.expectation_id}: unknown rubric criterion ${expectation.criterion_id}`);
    }
    const derivation = derivationPointer(expectation, fixtureRoot, pathPolicy);
    if (expectation.level === "hard") {
      if (!derivation) throw new Error(`${expectation.expectation_id}: hard expectation requires derivation`);
      hardExpectations.push({ ...expectation, derivation_pointer: derivation });
    } else {
      advisoryExpectations.push({ ...expectation, derivation_pointer: derivation });
    }
  }
  return {
    format: "split-v1",
    fixtureRoot,
    scenarioFile: scenarioPath,
    oracleFile: oraclePath,
    scenario,
    oracle,
    oracleSha256: sha256File(oraclePath),
    hardExpectations,
    advisoryExpectations,
  };
}

// Only this projection may feed hard assertions or score calculation.
export function scoreableOracle(fixture) {
  if (fixture.format !== "split-v1") throw new Error("scoreableOracle requires a split fixture");
  return fixture.hardExpectations.map((expectation) => ({ ...expectation }));
}
