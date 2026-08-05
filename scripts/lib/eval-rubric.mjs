// Deterministic rubric calculator. Criterion IDs, permitted values, maxima,
// normalization, and fixture gates are read from protocol under KN-0034.

import { loadProtocolFile } from "./protocol.mjs";
import { canonicalizeRecord } from "./machine-contract.mjs";

function rubricProtocol() {
  return loadProtocolFile("evaluation-rubric.schema.yaml");
}

function parseMinimums(value) {
  if (!value) return {};
  return Object.fromEntries(
    String(value)
      .split("|")
      .filter(Boolean)
      .map((item) => {
        const [criterionId, minimum] = item.split(":");
        return [criterionId, Number.parseInt(minimum, 10)];
      }),
  );
}

export function calculateRubricScore({ evaluator, criterionValues, hardAssertions = [] }) {
  const protocol = rubricProtocol();
  if (!protocol.evaluator_values.includes(evaluator)) throw new Error(`unknown evaluator: ${evaluator}`);
  if (criterionValues === null || typeof criterionValues !== "object" || Array.isArray(criterionValues)) {
    throw new Error("criterionValues must be a mapping");
  }
  const criterionRows = Object.entries(protocol.criteria).filter(([, row]) => row.evaluator === evaluator);
  const expectedIds = criterionRows.map(([criterionId]) => criterionId);
  const actualIds = Object.keys(criterionValues);
  if (JSON.stringify(actualIds.sort()) !== JSON.stringify([...expectedIds].sort())) {
    throw new Error(`criterionValues must cover exactly: ${expectedIds.join(", ")}`);
  }
  const criteria = criterionRows.map(([criterionId, row]) => {
    const allowed = String(row.values).split("|").map(Number);
    const value = criterionValues[criterionId];
    if (!Number.isInteger(value) || !allowed.includes(value)) {
      throw new Error(`${criterionId} score must be one of protocol values: ${allowed.join(" | ")}`);
    }
    return { criterion_id: criterionId, value, max_value: row.max };
  });
  const assertions = hardAssertions.map((assertion, index) => {
    if (assertion === null || typeof assertion !== "object" || typeof assertion.passed !== "boolean") {
      throw new Error(`hardAssertions[${index}] must carry a boolean passed field`);
    }
    return assertion;
  });
  const rawScore = criteria.reduce((sum, criterion) => sum + criterion.value, 0);
  const normalization = protocol.normalization[evaluator];
  if (rawScore > normalization.raw_max) throw new Error("rubric raw score exceeds protocol maximum");
  const normalizedScore = rawScore / normalization.divisor;
  const gate = protocol.fixture_gates[evaluator];
  const valuesById = Object.fromEntries(criteria.map((criterion) => [criterion.criterion_id, criterion.value]));
  const minimums = parseMinimums(gate.criterion_minimums);
  const exact = gate.required_exact_criterion;
  const exactPass = exact === null || valuesById[exact] === protocol.criteria[exact].max;
  const minimumsPass = Object.entries(minimums).every(([criterionId, minimum]) => valuesById[criterionId] >= minimum);
  const hardGatePass = assertions.every((assertion) => assertion.passed === true);
  const pass =
    normalizedScore >= gate.minimum_score &&
    (!gate.requires_all_hard || hardGatePass) &&
    exactPass &&
    minimumsPass;
  return {
    evaluator,
    criteria,
    raw_score: rawScore,
    normalized_score: normalizedScore,
    hard_gate_pass: hardGatePass,
    pass,
  };
}

export function buildEvaluationScore({
  evaluator,
  fixtureId,
  oracleSha256,
  productHashes,
  criterionChecks,
  hardAssertions = [],
  advisory = [],
  evaluatedAt,
}) {
  const criterionValues = Object.fromEntries(
    Object.entries(criterionChecks).map(([criterionId, checks]) => [criterionId, checks.value]),
  );
  const calculated = calculateRubricScore({ evaluator, criterionValues, hardAssertions });
  const criteria = calculated.criteria.map((criterion) => {
    const checks = criterionChecks[criterion.criterion_id];
    return {
      ...criterion,
      passed_checks: [...(checks.passed_checks ?? [])],
      failed_checks: [...(checks.failed_checks ?? [])],
    };
  });
  return canonicalizeRecord(
    {
      kind: "kg.evaluation_score",
      version: 1,
      evaluated_at: evaluatedAt,
      evaluator,
      fixture_id: fixtureId,
      oracle_sha256: oracleSha256,
      product_hashes: productHashes,
      criteria,
      raw_score: calculated.raw_score,
      normalized_score: calculated.normalized_score,
      hard_assertions: hardAssertions,
      hard_gate_pass: calculated.hard_gate_pass,
      advisory,
      pass: calculated.pass,
    },
    rubricProtocol(),
    "evaluation score",
  );
}
