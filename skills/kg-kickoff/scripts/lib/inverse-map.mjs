// Deterministic KN <-> carrier inverse-map validator.

import path from "node:path";
import * as host from "./host.mjs";
import * as protocol from "./protocol.mjs";

function issue(fields) {
  return {
    severity: "error",
    side: fields.side ?? "both",
    kn_id: fields.kn_id ?? null,
    artifact_id: fields.artifact_id ?? null,
    carrier_ref: fields.carrier_ref ?? null,
    issue: fields.issue,
    source_path: fields.source_path ?? null,
  };
}

function safeRelative(value, label, root) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const portable = value.replaceAll("\\", "/");
  if (portable.split("/").includes("..")) throw new Error(`${label} escapes the host root`);
  if (portable.split("/").some((segment) => segment.toLowerCase() === ".kg")) {
    throw new Error(`${label} enters .kg`);
  }
  if (!root) return portable.split("/").filter((segment) => segment && segment !== ".").join("/");
  return host.resolveSafeRelative(root, portable, { mustExist: false }).relative;
}

function suffixes() {
  return protocol.loadRouting().carrier_ref_suffixes;
}

export function parseCarrierRef(ref, { root } = {}) {
  if (typeof ref !== "string") throw new Error("carrier_ref must be a string");
  const at = ref.indexOf("@");
  const hash = ref.indexOf("#");
  if (at <= 0 || hash <= at + 1 || hash === ref.length - 1) throw new Error(`carrier_ref syntax is invalid: ${ref}`);
  const artifactId = ref.slice(0, at);
  const carrierPath = safeRelative(ref.slice(at + 1, hash), "carrier_ref path", root);
  const fragment = ref.slice(hash + 1);
  if (!/^HAR-[A-Z0-9][A-Z0-9._-]*$/.test(artifactId)) throw new Error(`carrier_ref artifact id is invalid: ${artifactId}`);
  const configured = suffixes();
  let mode;
  let carrierType = null;
  let proposalId = null;
  if (fragment === configured.managed) {
    mode = "managed";
  } else if (fragment === configured.co_managed_machine) {
    mode = "co_managed_machine";
  } else if (fragment.startsWith(`${configured.proposal}:`)) {
    const rest = fragment.slice(`${configured.proposal}:`.length);
    const separator = rest.indexOf(":");
    if (separator <= 0 || separator === rest.length - 1) throw new Error(`proposal carrier_ref is incomplete: ${ref}`);
    carrierType = rest.slice(0, separator);
    proposalId = rest.slice(separator + 1);
    const allowed = String(protocol.loadHarnessSchema().fields.type.values).split("|");
    if (!allowed.includes(carrierType)) throw new Error(`proposal carrier_ref type is invalid: ${carrierType}`);
    if (!/^compile-[a-z0-9][a-z0-9._-]*$/.test(proposalId)) throw new Error(`proposal carrier_ref id is invalid: ${proposalId}`);
    mode = "proposal";
  } else {
    throw new Error(`carrier_ref fragment is not in protocol: ${fragment}`);
  }
  return {
    artifact_id: artifactId,
    path: carrierPath,
    fragment,
    mode,
    carrier_type: carrierType,
    proposal_id: proposalId,
    canonical: `${artifactId}@${carrierPath}#${fragment}`,
  };
}

export function carrierRefForSidecar(record, { root } = {}) {
  const routing = protocol.loadRouting();
  const carrierPath = record.status === "proposed" || record.update_policy === "proposal_only" || record.ownership === "human" || record.type !== "markdown_document"
    ? record.candidate_path ?? record.path
    : record.path;
  const canonicalPath = safeRelative(carrierPath, "carrier path", root);
  if (record.type === "markdown_document" && record.ownership === "managed") {
    return `${record.artifact_id}@${canonicalPath}#${routing.carrier_ref_suffixes.managed}`;
  }
  if (record.type === "markdown_document" && record.ownership === "co_managed") {
    return `${record.artifact_id}@${canonicalPath}#${routing.carrier_ref_suffixes.co_managed_machine}`;
  }
  if (record.proposal_id === null || record.proposal_id === undefined) {
    throw new Error(`proposal carrier ${record.artifact_id} lacks proposal_id`);
  }
  return `${record.artifact_id}@${canonicalPath}#${routing.carrier_ref_suffixes.proposal}:${record.type}:${record.proposal_id}`;
}

function knowledgeRecord(entry) {
  return entry.frontmatter ?? entry;
}

function carrierRecord(entry) {
  return entry.sidecar ?? entry;
}

function pairKey(knId, ref) {
  return `${knId}\u0000${ref}`;
}

function sortedPairs(pairs) {
  return [...pairs].sort((a, b) => a.localeCompare(b));
}

export function validateInverseMap({ knowledgeEntries = [], carriers = [], root = null } = {}) {
  const findings = [];
  const knowledgeById = new Map();
  const carrierById = new Map();
  const fromCarriers = [];
  const fromKnowledge = [];

  for (const rawEntry of knowledgeEntries) {
    const entry = knowledgeRecord(rawEntry);
    if (!entry?.id) {
      findings.push(issue({ side: "knowledge", issue: "unknown_kn" }));
      continue;
    }
    if (knowledgeById.has(entry.id)) findings.push(issue({ side: "knowledge", kn_id: entry.id, issue: "duplicate_kn_id" }));
    knowledgeById.set(entry.id, entry);
    const refs = entry.carrier_refs ?? [];
    if (new Set(refs).size !== refs.length) findings.push(issue({ side: "knowledge", kn_id: entry.id, issue: "duplicate_carrier_ref" }));
    for (const ref of refs) {
      try {
        const parsed = parseCarrierRef(ref, { root });
        fromKnowledge.push(pairKey(entry.id, parsed.canonical));
      } catch (error) {
        findings.push(issue({ side: "knowledge", kn_id: entry.id, carrier_ref: ref, issue: "carrier_ref_parse_error", source_path: error.message }));
      }
    }
  }

  for (const rawCarrier of carriers) {
    const carrier = carrierRecord(rawCarrier);
    if (!carrier?.artifact_id) {
      findings.push(issue({ side: "carrier", issue: "unknown_artifact" }));
      continue;
    }
    if (carrierById.has(carrier.artifact_id)) findings.push(issue({ side: "carrier", artifact_id: carrier.artifact_id, issue: "duplicate_artifact_id" }));
    carrierById.set(carrier.artifact_id, carrier);
    const sourceIds = carrier.source_kn_ids ?? [];
    if (new Set(sourceIds).size !== sourceIds.length) findings.push(issue({ side: "carrier", artifact_id: carrier.artifact_id, issue: "duplicate_source_kn_id" }));
    if (sourceIds.length === 0 && carrier.ownership === "human" && carrier.proposal_id === null) continue;
    let ref;
    try {
      ref = carrierRefForSidecar(carrier, { root });
    } catch (error) {
      findings.push(issue({ side: "carrier", artifact_id: carrier.artifact_id, issue: "carrier_ref_build_error", source_path: error.message }));
      continue;
    }
    for (const knId of sourceIds) {
      if (!knowledgeById.has(knId)) findings.push(issue({ side: "carrier", kn_id: knId, artifact_id: carrier.artifact_id, carrier_ref: ref, issue: "unknown_kn" }));
      fromCarriers.push(pairKey(knId, ref));
    }
    if (carrier.status === "retired" && sourceIds.length > 0) {
      findings.push({ ...issue({ side: "carrier", artifact_id: carrier.artifact_id, issue: "retired_carrier_has_active_source_refs" }), severity: "warning" });
    }
  }

  for (const rawEntry of knowledgeEntries) {
    const entry = knowledgeRecord(rawEntry);
    for (const ref of entry.carrier_refs ?? []) {
      try {
        const parsed = parseCarrierRef(ref, { root });
        const carrier = carrierById.get(parsed.artifact_id);
        if (!carrier) {
          findings.push(issue({ side: "knowledge", kn_id: entry.id, artifact_id: parsed.artifact_id, carrier_ref: parsed.canonical, issue: "unknown_artifact" }));
          continue;
        }
        const expected = carrierRefForSidecar(carrier, { root });
        if (expected !== parsed.canonical) findings.push(issue({ side: "knowledge", kn_id: entry.id, artifact_id: parsed.artifact_id, carrier_ref: parsed.canonical, issue: "carrier_ref_target_mismatch" }));
      } catch {
        // The parse error was recorded in the first knowledge pass.
      }
    }
  }

  const carrierSet = new Set(fromCarriers);
  const knowledgeSet = new Set(fromKnowledge);
  for (const pair of sortedPairs([...carrierSet].filter((value) => !knowledgeSet.has(value)))) {
    const [knId, ref] = pair.split("\u0000");
    findings.push(issue({ side: "carrier", kn_id: knId, carrier_ref: ref, issue: "inverse_missing_knowledge_ref" }));
  }
  for (const pair of sortedPairs([...knowledgeSet].filter((value) => !carrierSet.has(value)))) {
    const [knId, ref] = pair.split("\u0000");
    findings.push(issue({ side: "knowledge", kn_id: knId, carrier_ref: ref, issue: "inverse_missing_carrier_ref" }));
  }
  for (const entry of knowledgeEntries.map(knowledgeRecord)) {
    if ((entry.carrier_refs ?? []).length === 0 && entry.lifecycle === "active") {
      const hasCarrierClaim = [...carrierById.values()].some((carrier) => (carrier.source_kn_ids ?? []).includes(entry.id));
      if (!hasCarrierClaim) findings.push({ ...issue({ side: "both", kn_id: entry.id, issue: "legacy_v1_without_v2_trace" }), severity: "warning" });
    }
  }
  findings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    findings,
    carrier_pairs: sortedPairs([...carrierSet]),
    knowledge_pairs: sortedPairs([...knowledgeSet]),
  };
}

export function assertInverseMap(input) {
  const result = validateInverseMap(input);
  const error = result.findings.find((finding) => finding.severity === "error");
  if (error) throw new Error(`inverse map validation failed: ${error.issue}`);
  return result;
}
