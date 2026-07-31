// Deterministic two-phase context gathering for the M1 kickoff spike.
// Index mode reads fixed project surfaces and metadata summaries. Deep mode
// reads only caller-selected paths that were present in the saved index.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harness, host, protocol } from "./_lib.mjs";

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
  const out = { include: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`无法识别参数 ${arg}`);
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

function runIndex(args, root, declaredRoot, output) {
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

function runDeep(args, root, declaredRoot, output) {
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

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!["index", "deep"].includes(args.phase)) fail("--phase 必须是 index 或 deep");
  if (!args.root) fail("缺少 --root");
  if (!args.output) fail("缺少 --output");
  const normalizedRoot = host.normalizeRoot(args.root);
  const root = normalizedRoot.canonical;
  const declaredRoot = declaredValue(args.root);
  const output = path.resolve(args.output);
  if (args.phase === "index") runIndex(args, root, declaredRoot, output);
  else runDeep(args, root, declaredRoot, output);
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
