// Deterministic two-phase context gathering for the M1 kickoff spike.
// Index mode reads fixed project surfaces and metadata summaries. Deep mode
// reads only caller-selected paths that were present in the saved index.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harness, host, kyaml, machineContract, protocol } from "./_lib.mjs";

const DEFAULT_INDEX_BUDGET = 64 * 1024;
const DEFAULT_DEEP_BUDGET = 128 * 1024;
const SENSITIVE_SEGMENTS = new Set([".git", ".ssh", "secrets", "credentials", "private"]);
const SENSITIVE_FILES = [
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

function fail(message) {
  console.error(`kg: 错误：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { include: [], compat_v1: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`无法识别参数 ${arg}`);
    if (arg === "--compat-v1") {
      out.compat_v1 = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} 缺少值`);
    i += 1;
    if (arg === "--include") out.include.push(value);
    else out[arg.slice(2).replaceAll("-", "_")] = value;
  }
  return out;
}

function parseBudget(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) fail("--budget 必须是正整数");
  return parsed;
}

function isSensitive(rel) {
  const parts = rel.split("/");
  if (parts.some((part) => part.toLowerCase() === ".kg" || SENSITIVE_SEGMENTS.has(part.toLowerCase()))) return true;
  return SENSITIVE_FILES.some((pattern) => pattern.test(parts.at(-1)));
}

function resolveSafeFile(root, rel, { mustExist = true } = {}) {
  if (!rel || path.isAbsolute(rel)) fail(`路径必须是项目内相对路径：${rel}`);
  const portable = rel.replaceAll("\\", "/");
  if (portable.split("/").includes("..")) {
    fail(`拒绝路径逃逸：${rel}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail(`拒绝路径逃逸：${rel}`);
  }
  if (isSensitive(normalized)) fail(`拒绝敏感或隔离路径：${rel}`);
  const full = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`拒绝路径逃逸：${rel}`);
  }
  let cursor = root;
  for (const segment of normalized.split("/")) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (mustExist) fail(`文件不存在：${normalized}`);
      break;
    }
    if (fs.lstatSync(cursor).isSymbolicLink()) fail(`拒绝符号链接：${normalized}`);
  }
  if (mustExist && !fs.statSync(full).isFile()) fail(`路径不是文件：${normalized}`);
  return { full, rel: normalized };
}

function listRegularFiles(root, relDir, accept) {
  const resolved = path.resolve(root, relDir);
  if (!fs.existsSync(resolved)) return [];
  const output = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (isSensitive(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && accept(rel)) output.push(rel);
    }
  }
  walk(resolved);
  return output;
}

function createBudget(limit) {
  return { limit, consumed: 0, truncated: false };
}

function readBudgeted(file, budget) {
  const raw = fs.readFileSync(file);
  const remaining = Math.max(0, budget.limit - budget.consumed);
  const used = Math.min(raw.length, remaining);
  const truncated = used < raw.length;
  budget.consumed += used;
  budget.truncated ||= truncated;
  return {
    content: raw.subarray(0, used).toString("utf8"),
    bytes: used,
    original_bytes: raw.length,
    truncated,
  };
}

function budgetReport(budget) {
  return {
    limit_bytes: budget.limit,
    consumed_bytes: budget.consumed,
    remaining_bytes: Math.max(0, budget.limit - budget.consumed),
    truncated: budget.truncated,
  };
}

function documentMetadata(text, rel) {
  if (!text.startsWith("---")) {
    return {
      title: path.basename(rel),
      status: "unregistered",
      authority: rel === "AGENTS.md" ? "project_instruction" : "reference_only",
      summary: text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "",
    };
  }
  try {
    const { frontmatter } = protocol.splitFrontmatter(text);
    const status = frontmatter.status ?? frontmatter.lifecycle ?? "unregistered";
    return {
      title: frontmatter.title ?? frontmatter.claim ?? path.basename(rel),
      status,
      authority:
        frontmatter.authority ??
        (status === "accepted" ? "formal_decision" : status === "active" ? "project_knowledge" : "reference_only"),
      claim: frontmatter.claim,
      scope: frontmatter.scope,
      doc_type: frontmatter.doc_type,
    };
  } catch (error) {
    return {
      title: path.basename(rel),
      status: "invalid_frontmatter",
      authority: "reference_only",
      parse_error: error.message,
    };
  }
}

function sourceRefPath(ref) {
  return String(ref).replace(/#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/, "");
}

function harnessIndex(root) {
  const entries = [];
  const sourcePaths = [];
  for (const rel of listRegularFiles(root, "harness", (file) => file.endsWith(".yaml"))) {
    try {
      const record = harness.readHarnessSidecar(root, path.join(root, ...rel.split("/")));
      const sourceRefIssues = [];
      for (const ref of record.source_refs) {
        const candidate = sourceRefPath(ref);
        try {
          const resolved = host.resolveSafeRelative(root, candidate);
          if (path.extname(resolved.relative).toLowerCase() !== ".md") {
            throw new Error(`source_ref 目标必须是 Markdown：${candidate}`);
          }
          if (!fs.statSync(resolved.full).isFile()) {
            throw new Error(`source_ref 目标不是文件：${candidate}`);
          }
          if (!sourcePaths.includes(resolved.relative)) sourcePaths.push(resolved.relative);
        } catch (error) {
          sourceRefIssues.push({
            source_ref: ref,
            error: error.message,
          });
        }
      }
      const entry = {
        path: rel,
        source: "harness",
        artifact_id: record.artifact_id,
        target_path: record.path,
        status: record.status,
        authority: "inventory_only",
        ownership: record.ownership,
        source_kn_ids: record.source_kn_ids,
        source_refs: record.source_refs,
      };
      if (sourceRefIssues.length > 0) entry.source_ref_issues = sourceRefIssues;
      entries.push(entry);
    } catch (error) {
      entries.push({
        path: rel,
        source: "harness",
        status: "invalid",
        authority: "inventory_only",
        parse_error: error.message,
      });
    }
  }
  return { entries, sourcePaths };
}

function fixedIndexPaths(root, harnessEntries, harnessSourcePaths) {
  const paths = ["AGENTS.md", "docs/README.md", "docs/glossary.md"];
  for (const rel of [
    "docs/architecture/overview.md",
    ...listRegularFiles(root, "docs/decisions", (file) => file.endsWith(".md")),
    ...listRegularFiles(root, "docs/standards", (file) => file.endsWith(".md")),
    ...listRegularFiles(root, "docs/traps", (file) => file.endsWith(".md")),
    ...listRegularFiles(root, "knowledge", (file) => /^knowledge\/KN-[^/]+\.md$/.test(file)),
    ...harnessEntries
      .map((entry) => entry.target_path)
      .filter((target) => typeof target === "string" && target.endsWith(".md")),
    ...harnessSourcePaths,
  ]) {
    if (!paths.includes(rel)) paths.push(rel);
  }
  return paths.filter((rel) => fs.existsSync(path.join(root, rel)));
}

function writeJson(output, value) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function declaredValue(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.normalize(value).split(path.sep).join("/");
}

function runLegacyIndex(args, root, declaredRoot, output) {
  if (!args.task) fail("--phase index 需要 --task");
  const budget = createBudget(parseBudget(args.budget, DEFAULT_INDEX_BUDGET));
  const { entries: harnessEntries, sourcePaths: harnessSourcePaths } = harnessIndex(root);
  const entries = [];
  for (const candidate of fixedIndexPaths(root, harnessEntries, harnessSourcePaths)) {
    const { full, rel } = resolveSafeFile(root, candidate);
    const read = readBudgeted(full, budget);
    const metadata = documentMetadata(read.content, rel);
    entries.push({
      path: rel,
      source:
        rel === "AGENTS.md" ? "project_instructions"
        : rel.startsWith("knowledge/") ? "knowledge"
        : "project_document",
      ...metadata,
      bytes: read.bytes,
      original_bytes: read.original_bytes,
      truncated: read.truncated,
    });
    if (budget.consumed >= budget.limit) break;
  }
  writeJson(output, {
    kind: "kg.kickoff_context_index",
    version: 1,
    project_root: declaredRoot,
    task: args.task,
    entries,
    harness: harnessEntries,
    budget: budgetReport(budget),
  });
  console.log(`kg: 索引阶段完成，收录 ${entries.length} 项，使用 ${budget.consumed}/${budget.limit} 字节`);
}

function runLegacyDeep(args, root, declaredRoot, output) {
  if (!args.index) fail("--phase deep 需要 --index");
  if (args.include.length === 0) fail("--phase deep 至少需要一个 --include");
  const index = JSON.parse(fs.readFileSync(path.resolve(args.index), "utf8"));
  if (index.kind !== "kg.kickoff_context_index") fail("--index 不是 kickoff context index");
  if (host.canonicalPath(path.isAbsolute(index.project_root) ? index.project_root : path.resolve(index.project_root)) !== root) {
    fail("--index 的项目根目录与 --root 不一致");
  }
  const indexed = new Map(index.entries.map((entry) => [entry.path, entry]));
  const budget = createBudget(parseBudget(args.budget, DEFAULT_DEEP_BUDGET));
  const documents = [];
  for (const include of args.include) {
    const { full, rel } = resolveSafeFile(root, include);
    const metadata = indexed.get(rel);
    if (!metadata) fail(`路径未出现在索引中：${rel}`);
    const read = readBudgeted(full, budget);
    documents.push({
      path: rel,
      source: metadata.source,
      status: metadata.status,
      authority: metadata.authority,
      content: read.content,
      bytes: read.bytes,
      original_bytes: read.original_bytes,
      truncated: read.truncated,
    });
    if (budget.consumed >= budget.limit) break;
  }
  writeJson(output, {
    kind: "kg.kickoff_context",
    version: 1,
    project_root: declaredRoot,
    index_path: declaredValue(args.index),
    documents,
    budget: budgetReport(budget),
  });
  console.log(`kg: 深读阶段完成，读取 ${documents.length} 份文档，使用 ${budget.consumed}/${budget.limit} 字节`);
}

function listValue(value) {
  return Array.isArray(value) ? value.map(String) : String(value ?? "").split("|").filter(Boolean);
}

function policySets(schema) {
  const policy = schema.discovery_policy;
  return {
    headerBytes: policy.metadata_header_bytes,
    maximumBytes: policy.maximum_source_bytes,
    dependency: new Set(listValue(policy.dependency_directories).map((item) => item.toLowerCase())),
    generated: new Set(listValue(policy.generated_directories).map((item) => item.toLowerCase())),
    sensitiveSegments: new Set(listValue(policy.sensitive_segments).map((item) => item.toLowerCase())),
    sensitiveNames: new Set(listValue(policy.sensitive_file_names).map((item) => item.toLowerCase())),
    sensitiveExtensions: new Set(listValue(policy.sensitive_extensions).map((item) => item.toLowerCase())),
    markdownExtensions: new Set(listValue(policy.markdown_extensions).map((item) => item.toLowerCase())),
    sidecarExtensions: new Set(listValue(policy.sidecar_extensions).map((item) => item.toLowerCase())),
  };
}

function pathExclusion(rel, policies) {
  const parts = rel.split("/").filter(Boolean);
  const lower = parts.map((item) => item.toLowerCase());
  if (lower.includes(".kg")) return "kg_isolation";
  if (lower.some((item) => policies.dependency.has(item))) return "dependency";
  if (lower.some((item) => policies.generated.has(item))) return "generated";
  if (lower.some((item) => policies.sensitiveSegments.has(item))) return "sensitive";
  const name = lower.at(-1) ?? "";
  if (policies.sensitiveNames.has(name) || policies.sensitiveExtensions.has(path.posix.extname(name))) return "sensitive";
  return null;
}

function lineCount(buffer) {
  if (buffer.length === 0) return 0;
  let lines = 1;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  if (buffer.at(-1) === 0x0a) lines -= 1;
  return lines;
}

function readCatalogFile(root, rel, policies) {
  const resolved = host.resolveSafeRelative(root, rel);
  if (!fs.statSync(resolved.full).isFile()) throw new Error(`catalog path is not a file: ${rel}`);
  const size = fs.statSync(resolved.full).size;
  if (size > policies.maximumBytes) return { exclusion: "oversized" };
  const bytes = fs.readFileSync(resolved.full);
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return { exclusion: "binary" };
  return {
    resolved,
    bytes,
    header: bytes.subarray(0, Math.min(bytes.length, policies.headerBytes)).toString("utf8"),
    sha256: machineContract.sha256Bytes(bytes),
    lineCount: lineCount(bytes),
  };
}

function walkRoute(root, rel, sourceClass, accept, policies, addCandidate, addExclusion) {
  const route = host.resolveSafeRelative(root, rel, { mustExist: false });
  if (!fs.existsSync(route.full)) return;
  function walk(current, currentRel) {
    const stat = fs.lstatSync(current);
    const excluded = pathExclusion(currentRel, policies);
    if (excluded) {
      addExclusion(sourceClass, currentRel, excluded);
      return;
    }
    if (stat.isSymbolicLink()) {
      addExclusion(sourceClass, currentRel, "symlink");
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = currentRel === "" ? entry.name : `${currentRel}/${entry.name}`;
        walk(path.join(current, entry.name), childRel);
      }
      return;
    }
    if (!stat.isFile() || !accept(currentRel)) return;
    const inspected = readCatalogFile(root, currentRel, policies);
    if (inspected.exclusion) addExclusion(sourceClass, currentRel, inspected.exclusion);
    else addCandidate(currentRel, sourceClass, { inspected });
  }
  walk(route.full, route.relative);
}

function firstHeading(header) {
  return header.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function metadataFromHeader(candidate) {
  const { rel, sourceClass, inspected, docTypeHint, metadataOverride } = candidate;
  let frontmatter = null;
  let parseError = null;
  if (inspected.header.startsWith("---")) {
    try {
      ({ frontmatter } = protocol.splitFrontmatter(inspected.header));
    } catch (error) {
      parseError = error.message;
    }
  }
  const status = parseError
    ? "invalid_frontmatter"
    : frontmatter?.status ?? frontmatter?.lifecycle ?? metadataOverride?.status ?? "unregistered";
  const authority = frontmatter?.authority ?? metadataOverride?.authority ??
    (rel === "AGENTS.md" ? "project_instruction"
      : status === "accepted" ? "formal_decision"
      : status === "active" ? "project_knowledge"
      : "reference_only");
  const scopeValues = [];
  const scope = frontmatter?.scope;
  if (typeof scope === "string") scopeValues.push(scope);
  if (Array.isArray(scope)) scopeValues.push(...scope.map(String));
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    for (const value of Object.values(scope)) {
      if (typeof value === "string") scopeValues.push(value);
      else if (Array.isArray(value)) scopeValues.push(...value.map(String));
    }
  }
  const pathTokens = rel
    .replace(/\.[^.]+$/, "")
    .split(/[\/_.-]+/)
    .map((item) => item.toLowerCase())
    .filter(Boolean);
  const scopeTokens = scopeValues.flatMap((item) => String(item).split(/[^A-Za-z0-9]+/)).map((item) => item.toLowerCase()).filter(Boolean);
  const docType = frontmatter?.doc_type ?? docTypeHint ?? null;
  const metadata = {
    ...(metadataOverride ?? {}),
    ...(frontmatter?.id ? { knowledge_id: frontmatter.id } : {}),
    ...(frontmatter?.claim ? { claim: frontmatter.claim } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(frontmatter?.lifecycle ? { lifecycle: frontmatter.lifecycle } : {}),
    ...(frontmatter?.carrier_refs ? { carrier_refs: frontmatter.carrier_refs } : {}),
    ...(parseError ? { parse_error: parseError } : {}),
  };
  return {
    title: frontmatter?.title ?? frontmatter?.claim ?? firstHeading(inspected.header),
    docType,
    status,
    authority,
    domainKeys: [...new Set([...pathTokens, ...scopeTokens, ...(docType ? [String(docType).toLowerCase()] : [])])].sort(),
    summary: frontmatter?.claim ?? null,
    metadata,
  };
}

function markdownLinks(text, fromPath) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "").split("#")[0].split("?")[0];
    if (raw === "" || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      continue;
    }
    links.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), decoded)));
  }
  return [...new Set(links)];
}

function sourceId(sourceClass, rel) {
  return `SRC-${crypto.createHash("sha256").update(`${sourceClass}\0${rel}`).digest("hex").slice(0, 12).toUpperCase()}`;
}

function globRegex(pattern) {
  const doubleStar = "\u0000";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", doubleStar)
    .replaceAll("*", "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${escaped}$`);
}

function runProtocolIndex(args, root, output) {
  if (!args.task) fail("--phase index 需要 --task");
  if (path.extname(output).toLowerCase() !== ".json") {
    throw new Error("protocol index output must use .json because entry metadata is nested");
  }
  const schema = protocol.loadKickoffIndexSchema();
  const policies = policySets(schema);
  const candidates = new Map();
  const exclusions = new Map();
  const pendingEdges = [];
  const addExclusion = (sourceClass, rel, reason) => {
    const row = { source_class: sourceClass, path: rel, reason, count: 1 };
    exclusions.set(`${sourceClass}\0${rel}\0${reason}`, row);
  };
  const addCandidate = (rel, sourceClass, extra = {}) => {
    const portable = rel.replaceAll("\\", "/");
    const exclusion = pathExclusion(portable, policies);
    if (exclusion) {
      addExclusion(sourceClass, portable, exclusion);
      return;
    }
    const current = candidates.get(portable);
    const candidate = { rel: portable, sourceClass, ...current, ...extra };
    candidate.sourceClass = sourceClass;
    candidates.set(portable, candidate);
  };
  const taxonomy = protocol.loadDocumentTaxonomy();
  const sourceClasses = schema.source_classes;
  const classByDiscovery = new Map(Object.entries(sourceClasses).map(([name, row]) => [row.discovery, name]));
  for (const [sourceClass, row] of Object.entries(sourceClasses)) {
    const patterns = listValue(row.include_patterns);
    if (row.discovery === "root_agents_md") {
      for (const rel of patterns) {
        if (!fs.existsSync(path.join(root, rel))) continue;
        const inspected = readCatalogFile(root, rel, policies);
        if (inspected.exclusion) addExclusion(sourceClass, rel, inspected.exclusion);
        else addCandidate(rel, sourceClass, { inspected });
      }
    } else if (row.discovery === "docs_readme_links") {
      for (const rel of patterns) {
        if (!fs.existsSync(path.join(root, rel))) continue;
        const inspected = readCatalogFile(root, rel, policies);
        if (inspected.exclusion) {
          addExclusion(sourceClass, rel, inspected.exclusion);
          continue;
        }
        addCandidate(rel, sourceClass, { inspected, metadataOverride: { registration_hint: true } });
        for (const linked of markdownLinks(inspected.bytes.toString("utf8"), rel)) {
          if (linked.startsWith("../") || path.posix.isAbsolute(linked)) {
            addExclusion(sourceClass, linked, "outside_root");
            continue;
          }
          if (!policies.markdownExtensions.has(path.posix.extname(linked).toLowerCase())) continue;
          try {
            const linkedInspected = readCatalogFile(root, linked, policies);
            if (linkedInspected.exclusion) addExclusion(sourceClass, linked, linkedInspected.exclusion);
            else {
              addCandidate(linked, sourceClass, { inspected: linkedInspected, metadataOverride: { registration_hint: true } });
              pendingEdges.push({ fromPath: rel, toPath: linked, edgeType: "document_link", anchor: null });
            }
          } catch {
            addExclusion(sourceClass, linked, "outside_root");
          }
        }
      }
    } else if (row.discovery === "taxonomy_routes") {
      const routes = new Map();
      for (const [docType, record] of Object.entries(taxonomy.documents)) {
        const route = record.path.endsWith("/") ? record.path.slice(0, -1) : record.path;
        const types = routes.get(route) ?? [];
        types.push(docType);
        routes.set(route, types);
      }
      for (const [route, docTypes] of routes) {
        walkRoute(
          root,
          route,
          sourceClass,
          (rel) => policies.markdownExtensions.has(path.posix.extname(rel).toLowerCase()),
          policies,
          (rel, klass, extra) => addCandidate(rel, klass, { ...extra, docTypeHint: docTypes.length === 1 ? docTypes[0] : null }),
          addExclusion,
        );
      }
    } else if (row.discovery === "active_knowledge_glob") {
      for (const pattern of patterns) {
        const directory = pattern.slice(0, pattern.indexOf("*"));
        const base = directory.endsWith("/") ? directory.slice(0, -1) : path.posix.dirname(directory);
        const accept = globRegex(pattern);
        walkRoute(root, base, sourceClass, (rel) => accept.test(rel), policies, addCandidate, addExclusion);
      }
    } else if (row.discovery === "harness_sidecars") {
      for (const pattern of patterns) {
        const base = pattern.split("/**")[0];
        walkRoute(
          root,
          base,
          sourceClass,
          (rel) => policies.sidecarExtensions.has(path.posix.extname(rel).toLowerCase()),
          policies,
          addCandidate,
          addExclusion,
        );
      }
    }
  }

  const harnessInventoryClass = classByDiscovery.get("harness_sidecars");
  const harnessClosureClass = classByDiscovery.get("harness_target_and_source_refs");
  const knowledgeClass = classByDiscovery.get("active_knowledge_glob");
  if (!harnessInventoryClass || !harnessClosureClass || !knowledgeClass) {
    throw new Error("kickoff source-class protocol is missing a required discovery role");
  }
  const sidecarsByArtifact = new Map();
  for (const candidate of [...candidates.values()].filter((item) => item.sourceClass === harnessInventoryClass)) {
    let details;
    try {
      const record = harness.readHarnessSidecar(root, candidate.inspected.resolved.full);
      details = {
        artifact_id: record.artifact_id,
        type: record.type,
        target_path: record.path,
        ownership: record.ownership,
        status: record.status,
        source_kn_ids: record.source_kn_ids,
        source_refs: record.source_refs,
        parse_issues: [],
        authority: "inventory_only",
      };
      sidecarsByArtifact.set(record.artifact_id, { path: candidate.rel, targetPath: record.path });
      for (const [edgeType, ref] of [
        ["harness_target", record.path],
        ...record.source_refs.map((sourceRef) => ["harness_source", sourceRefPath(sourceRef)]),
      ]) {
        if (typeof ref !== "string" || !policies.markdownExtensions.has(path.posix.extname(ref).toLowerCase())) continue;
        try {
          const inspected = readCatalogFile(root, ref, policies);
          if (inspected.exclusion) addExclusion(harnessClosureClass, ref, inspected.exclusion);
          else {
            addCandidate(ref, harnessClosureClass, { inspected, metadataOverride: { closure_edge_type: edgeType } });
            pendingEdges.push({ fromPath: candidate.rel, toPath: ref, edgeType, anchor: null });
          }
        } catch (error) {
          details.parse_issues.push({ ref, error: error.message });
        }
      }
    } catch (error) {
      details = { parse_issues: [{ error: error.message }], status: "invalid", authority: "inventory_only" };
    }
    candidate.metadataOverride = details;
  }

  for (const candidate of [...candidates.values()].filter((item) => item.sourceClass === knowledgeClass)) {
    const metadata = metadataFromHeader(candidate).metadata;
    for (const carrierRef of metadata.carrier_refs ?? []) {
      const artifactId = String(carrierRef).split("@")[0];
      const sidecar = sidecarsByArtifact.get(artifactId);
      if (sidecar?.targetPath && candidates.has(sidecar.targetPath)) {
        pendingEdges.push({ fromPath: candidate.rel, toPath: sidecar.targetPath, edgeType: "knowledge_carrier", anchor: carrierRef });
      }
    }
  }

  const budgetLimit = parseBudget(args.budget, DEFAULT_INDEX_BUDGET);
  let metadataBytesUsed = 0;
  const omitted = [];
  const entries = [...candidates.values()]
    .sort((left, right) => left.rel.localeCompare(right.rel))
    .map((candidate) => {
      const metadata = metadataFromHeader(candidate);
      const optional = {
        title: metadata.title,
        domain_keys: metadata.domainKeys,
        summary: metadata.summary,
        metadata: metadata.metadata,
      };
      const cost = Buffer.byteLength(machineContract.canonicalJson(optional), "utf8");
      const keep = metadataBytesUsed + cost <= budgetLimit;
      if (keep) metadataBytesUsed += cost;
      else omitted.push(candidate.rel);
      return {
        source_id: sourceId(candidate.sourceClass, candidate.rel),
        source_class: candidate.sourceClass,
        path: candidate.rel,
        sha256: candidate.inspected.sha256,
        title: keep ? metadata.title : null,
        line_count: candidate.inspected.lineCount,
        doc_type: metadata.docType,
        status: metadata.status,
        authority: metadata.authority,
        domain_keys: keep ? metadata.domainKeys : [],
        summary: keep ? metadata.summary : null,
        metadata: keep ? metadata.metadata : {},
        metadata_truncated: !keep,
      };
    });
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const exclusionRows = [...exclusions.values()];
  const edges = pendingEdges
    .filter((edge) => entryByPath.has(edge.fromPath) && entryByPath.has(edge.toPath))
    .map((edge) => ({
      from_source_id: entryByPath.get(edge.fromPath).source_id,
      to_source_id: entryByPath.get(edge.toPath).source_id,
      edge_type: edge.edgeType,
      anchor: edge.anchor,
    }))
    .filter((edge, index, all) => all.findIndex((item) => machineContract.canonicalJson(item) === machineContract.canonicalJson(edge)) === index)
    .sort((left, right) => machineContract.canonicalJson(left).localeCompare(machineContract.canonicalJson(right)));
  const sourceCounts = Object.keys(sourceClasses).map((sourceClass) => {
    const included = entries.filter((entry) => entry.source_class === sourceClass).length;
    const excluded = exclusionRows.filter((entry) => entry.source_class === sourceClass).reduce((sum, entry) => sum + entry.count, 0);
    return { source_class: sourceClass, total: included + excluded, included, excluded };
  });
  const record = machineContract.canonicalizeRecord({
    kind: schema.product_kind,
    version: schema.product_version,
    indexed_at: (args.now ? new Date(args.now) : new Date()).toISOString(),
    project_root: root,
    task_sha256: machineContract.sha256Bytes(args.task),
    catalog_status: omitted.length > 0 ? "metadata_truncated" : "complete",
    source_counts: sourceCounts,
    entries,
    edges,
    exclusions: exclusionRows.sort((left, right) => machineContract.canonicalJson(left).localeCompare(machineContract.canonicalJson(right))),
    omission_digest: machineContract.sha256CanonicalJson(omitted.sort()),
    metadata_budget_bytes: budgetLimit,
    metadata_bytes_used: metadataBytesUsed,
  }, schema, "kickoff context index");
  machineContract.writeCanonicalRecord(output, record, schema, { label: "kickoff context index" });
  console.log(`kg: protocol index complete; ${entries.length} entries, ${exclusionRows.length} exclusions, ${metadataBytesUsed}/${budgetLimit} metadata bytes`);
}

function readMachine(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`${label} is not a real file`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  return {
    file: resolved,
    value: path.extname(resolved).toLowerCase() === ".json" || text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : kyaml.parse(text),
  };
}

function runProtocolDeep(args, root, output) {
  if (!args.index || !args.scope) fail("--phase deep 需要 --index 与 --scope");
  if (args.include.length > 0) fail("protocol deep 不接受 --include；请先写 scope product");
  const indexFile = readMachine(args.index, "index");
  const scopeFile = readMachine(args.scope, "scope");
  const indexSchema = protocol.loadKickoffIndexSchema();
  const scopeSchema = protocol.loadKickoffScopeSchema();
  const deepSchema = protocol.loadKickoffDeepSchema();
  const indexErrors = protocol.validateRecord(indexFile.value, indexSchema);
  const scopeErrors = protocol.validateRecord(scopeFile.value, scopeSchema);
  if (indexErrors.length > 0) throw new Error(`index is invalid: ${indexErrors.join("; ")}`);
  if (scopeErrors.length > 0) throw new Error(`scope is invalid: ${scopeErrors.join("; ")}`);
  if (host.canonicalPath(indexFile.value.project_root) !== root) throw new Error("index project_root differs from --root");
  const indexSha256 = machineContract.sha256File(indexFile.file);
  if (scopeFile.value.index_sha256 !== indexSha256 || scopeFile.value.task_sha256 !== indexFile.value.task_sha256) {
    throw new Error("scope is not bound to the supplied index and task");
  }
  const entryByPath = new Map(indexFile.value.entries.map((entry) => [entry.path, entry]));
  const selectedPaths = scopeFile.value.selected_sources.map((item) => item.source_path);
  if (new Set(selectedPaths).size !== selectedPaths.length) throw new Error("scope selected_sources contains duplicates");
  const preflight = [...selectedPaths].sort().map((sourcePath) => {
    const entry = entryByPath.get(sourcePath);
    if (!entry) throw new Error(`scope path is absent from index: ${sourcePath}`);
    const identity = machineContract.canonicalFileIdentity(root, sourcePath);
    const selection = scopeFile.value.selected_sources.find((item) => item.source_path === sourcePath);
    if (identity.sha256 !== entry.sha256 || identity.sha256 !== selection.source_sha256) {
      throw new Error(`source changed after scope creation: ${sourcePath}`);
    }
    return { entry, identity };
  });
  const budget = createBudget(parseBudget(args.budget, DEFAULT_DEEP_BUDGET));
  const documents = preflight.map(({ entry, identity }) => {
    const read = readBudgeted(identity.canonical_path, budget);
    return {
      path: entry.path,
      source_id: entry.source_id,
      source_class: entry.source_class,
      sha256: identity.sha256,
      status: entry.status,
      authority: entry.authority,
      content: read.content,
      bytes: read.bytes,
      original_bytes: read.original_bytes,
      truncated: read.truncated,
    };
  });
  const report = budgetReport(budget);
  const record = machineContract.canonicalizeRecord({
    kind: deepSchema.product_kind,
    version: deepSchema.product_version,
    read_at: (args.now ? new Date(args.now) : new Date()).toISOString(),
    project_root: root,
    index_sha256: indexSha256,
    scope_sha256: machineContract.sha256File(scopeFile.file),
    documents,
    budget: report,
  }, deepSchema, "kickoff context");
  machineContract.writeCanonicalRecord(output, record, deepSchema, { label: "kickoff context" });
  console.log(`kg: exact-set deep read complete; ${documents.length} documents, ${report.consumed_bytes}/${report.limit_bytes} bytes`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!["index", "deep"].includes(args.phase)) fail("--phase 必须是 index 或 deep");
  if (!args.root) fail("缺少 --root");
  if (!args.output) fail("缺少 --output");
  const normalizedRoot = host.normalizeRoot(args.root);
  const root = normalizedRoot.canonical;
  const declaredRoot = declaredValue(args.root);
  const output = path.resolve(args.output);
  try {
    if (args.compat_v1) {
      if (args.phase === "index") runLegacyIndex(args, root, declaredRoot, output);
      else runLegacyDeep(args, root, declaredRoot, output);
    } else if (args.phase === "index") runProtocolIndex(args, root, output);
    else runProtocolDeep(args, root, output);
  } catch (error) {
    fail(error.message);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) main();
