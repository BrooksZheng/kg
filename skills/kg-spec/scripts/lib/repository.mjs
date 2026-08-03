// Static repository inventory shared by kg-docs bootstrap and later scan
// work. It reads bounded text files, follows no symlinks, and never executes
// host code.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";

const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".claude",
  ".git",
  ".kg",
  ".next",
  ".nuxt",
  ".terraform",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "deriveddata",
  "dist",
  "generated",
  "node_modules",
  "out",
  "pods",
  "target",
  "vendor",
  "venv",
]);

const SENSITIVE_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".ssh",
  "certificates",
  "certs",
  "credentials",
  "keys",
  "secrets",
]);

const SENSITIVE_FILES = new Set([
  ".dockercfg",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "service_account.json",
]);

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".fish",
  ".go",
  ".gradle",
  ".graphql",
  ".gql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".mjs",
  ".md",
  ".php",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const SPECIAL_TEXT_FILES = new Set([
  "dockerfile",
  "gemfile",
  "justfile",
  "makefile",
  "procfile",
  "rakefile",
]);

const MANIFEST_NAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "composer.json",
  "docker-compose.yaml",
  "docker-compose.yml",
  "dockerfile",
  "gemfile",
  "go.mod",
  "justfile",
  "makefile",
  "mix.exs",
  "package.json",
  "package.swift",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts",
  "taskfile.yaml",
  "taskfile.yml",
]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".swift",
  ".ts",
  ".tsx",
]);

const INVENTORY_FIELDS = [
  "kind",
  "version",
  "generated_at",
  "static_only",
  "root_path",
  "root_name",
  "limits",
  "truncated",
  "truncation_reasons",
  "stats",
  "files",
  "evidence",
];

const LIMIT_FIELDS = ["max_files", "max_bytes_per_file", "max_evidence"];
const STATS_FIELDS = [
  "safe_files",
  "excluded_directories",
  "excluded_kg_directories",
  "excluded_sensitive_directories",
  "excluded_sensitive_files",
  "excluded_binary_files",
  "excluded_oversized_files",
  "excluded_symlinks",
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function inventoryDigest(inventory) {
  return sha256(Buffer.from(canonicalJson(inventory), "utf8"));
}

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isSensitiveFile(name) {
  const lower = name.toLowerCase();
  return (
    SENSITIVE_FILES.has(lower) ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.includes("credential") ||
    lower.includes("private-key") ||
    lower.includes("secret") ||
    lower.startsWith("id_rsa") ||
    lower.startsWith("id_ed25519") ||
    [".db", ".der", ".jks", ".kdbx", ".key", ".keystore", ".ovpn", ".p12", ".pem", ".pfx", ".sqlite", ".sqlite3"].some(
      (extension) => lower.endsWith(extension),
    )
  );
}

function looksTextual(name) {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.has(path.extname(lower)) || SPECIAL_TEXT_FILES.has(lower);
}

function isTextBuffer(buffer) {
  if (buffer.includes(0)) return false;
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) return false;
  for (const byte of buffer) {
    if (byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte)) return false;
  }
  return true;
}

function assertEligibleInventoryPath(root, relative, maxBytesPerFile) {
  if (normalizeRelative(relative) !== relative || relative === "") {
    throw new Error(`inventory path is not canonical: ${relative}`);
  }
  const segments = relative.split("/");
  const directorySegments = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (directorySegments.includes(".kg")) throw new Error(`inventory path enters excluded .kg: ${relative}`);
  if (directorySegments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    throw new Error(`inventory path enters a sensitive directory: ${relative}`);
  }
  if (directorySegments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
    throw new Error(`inventory path enters an excluded directory: ${relative}`);
  }
  const name = segments.at(-1);
  if (isSensitiveFile(name)) throw new Error(`inventory path is sensitive: ${relative}`);
  if (!looksTextual(name)) throw new Error(`inventory path is not an allowed text file: ${relative}`);
  const resolved = host.resolveSafeRelative(root, relative);
  if (!fs.statSync(resolved.full).isFile()) throw new Error(`inventory path is not a file: ${relative}`);
  const buffer = fs.readFileSync(resolved.full);
  if (buffer.byteLength > maxBytesPerFile) throw new Error(`inventory path exceeds the byte limit: ${relative}`);
  if (!isTextBuffer(buffer)) throw new Error(`inventory path is binary: ${relative}`);
  return { resolved, buffer };
}

function fileKind(relative) {
  const lowerName = path.basename(relative).toLowerCase();
  const extension = path.extname(lowerName);
  if (MANIFEST_NAMES.has(lowerName)) return "manifest";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  if (extension === ".md") return "document";
  if ([".json", ".toml", ".yaml", ".yml"].includes(extension)) return "config";
  return "text";
}

function redact(value) {
  return String(value)
    .replace(/(token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2<redacted>")
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, "://<redacted>:<redacted>@")
    .trim()
    .slice(0, 240);
}

function evidenceKind(relative, line) {
  const lowerName = path.basename(relative).toLowerCase();
  if (MANIFEST_NAMES.has(lowerName)) return "manifest";
  if (/^\s*(?:import|export\s+.+\s+from|require\s*\()/.test(line)) return "module_link";
  if (
    /\b(?:fetch|https?\.request|axios|grpc|connect|publish|send)\s*\(/i.test(line) ||
    /\bhttps?:\/\//i.test(line)
  ) {
    return "external_boundary";
  }
  if (
    /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+[A-Za-z_$][\w$]*/.test(line) ||
    /^\s*(?:public\s+)?(?:class|interface|record|enum)\s+[A-Z][A-Za-z0-9_]*/.test(line)
  ) {
    return "public_symbol";
  }
  if (
    /(?:^|\/)(?:main|index|server|app)\.[A-Za-z0-9]+$/i.test(relative) &&
    line.trim() !== "" &&
    !line.trimStart().startsWith("//")
  ) {
    return "entrypoint";
  }
  return null;
}

function integerOption(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

export function buildRepositoryInventory(options = {}) {
  const root = host.assertSafeHostRoot(options.root ?? process.cwd());
  const maxFiles = integerOption(options.maxFiles, 5000, "maxFiles");
  const maxBytesPerFile = integerOption(options.maxBytesPerFile, 512000, "maxBytesPerFile");
  const maxEvidence = integerOption(options.maxEvidence, 300, "maxEvidence");
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid inventory timestamp: ${options.now}`);
  const customExcludes = (options.exclude ?? []).map(normalizeRelative).filter(Boolean);
  const stats = {
    safe_files: 0,
    excluded_directories: 0,
    excluded_kg_directories: 0,
    excluded_sensitive_directories: 0,
    excluded_sensitive_files: 0,
    excluded_binary_files: 0,
    excluded_oversized_files: 0,
    excluded_symlinks: 0,
  };
  const files = [];
  const evidence = [];
  const truncationReasons = [];
  let truncated = false;
  let traversalStopped = false;

  function customExcluded(relative) {
    return customExcludes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  }

  function walk(directory) {
    if (traversalStopped) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (traversalStopped) break;
      const full = path.join(directory, entry.name);
      const relative = normalizeRelative(path.relative(root, full));
      const lowerName = entry.name.toLowerCase();
      if (entry.isSymbolicLink()) {
        stats.excluded_symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (lowerName === ".kg") {
          stats.excluded_kg_directories += 1;
          continue;
        }
        if (SENSITIVE_DIRECTORIES.has(lowerName)) {
          stats.excluded_sensitive_directories += 1;
          continue;
        }
        if (EXCLUDED_DIRECTORIES.has(lowerName) || customExcluded(relative)) {
          stats.excluded_directories += 1;
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile() || customExcluded(relative)) continue;
      if (isSensitiveFile(entry.name)) {
        stats.excluded_sensitive_files += 1;
        continue;
      }
      if (!looksTextual(entry.name)) {
        stats.excluded_binary_files += 1;
        continue;
      }
      const size = fs.statSync(full).size;
      if (size > maxBytesPerFile) {
        stats.excluded_oversized_files += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        traversalStopped = true;
        truncationReasons.push("max_files");
        break;
      }

      const buffer = fs.readFileSync(full);
      if (!isTextBuffer(buffer)) {
        stats.excluded_binary_files += 1;
        continue;
      }
      const content = buffer.toString("utf8");
      const lines = content.split(/\r?\n/);
      const record = {
        path: relative,
        kind: fileKind(relative),
        bytes: buffer.byteLength,
        line_count: lines.length,
        sha256: sha256(buffer),
      };
      files.push(record);
      stats.safe_files += 1;

      for (let index = 0; index < lines.length; index += 1) {
        const kind = evidenceKind(relative, lines[index]);
        if (!kind) continue;
        if (evidence.length >= maxEvidence) {
          truncated = true;
          if (!truncationReasons.includes("max_evidence")) truncationReasons.push("max_evidence");
          continue;
        }
        evidence.push({
          kind,
          path: relative,
          line_start: index + 1,
          line_end: index + 1,
          text: redact(lines[index]),
        });
      }
    }
  }

  walk(root);
  return {
    kind: "kg.repository_inventory",
    version: 1,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    static_only: true,
    root_path: root,
    root_name: path.basename(root),
    limits: {
      max_files: maxFiles,
      max_bytes_per_file: maxBytesPerFile,
      max_evidence: maxEvidence,
    },
    truncated,
    truncation_reasons: truncationReasons,
    stats,
    files,
    evidence,
  };
}

function rejectUnknown(record, allowed, label) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

export function validateRepositoryInventory(inventory, projectRoot) {
  rejectUnknown(inventory, INVENTORY_FIELDS, "inventory");
  if (inventory.kind !== "kg.repository_inventory" || inventory.version !== 1 || inventory.static_only !== true) {
    throw new Error("inventory kind, version, or static_only is invalid");
  }
  const root = host.assertSafeHostRoot(projectRoot);
  if (host.canonicalPath(inventory.root_path) !== root) throw new Error("inventory root does not match project root");
  if (!Array.isArray(inventory.files) || !Array.isArray(inventory.evidence)) {
    throw new Error("inventory files and evidence must be arrays");
  }
  if (typeof inventory.truncated !== "boolean" || !Array.isArray(inventory.truncation_reasons)) {
    throw new Error("inventory truncation fields are invalid");
  }
  rejectUnknown(inventory.limits, LIMIT_FIELDS, "inventory.limits");
  for (const field of LIMIT_FIELDS) {
    if (!Number.isInteger(inventory.limits[field]) || inventory.limits[field] <= 0) {
      throw new Error(`inventory.limits.${field} must be a positive integer`);
    }
  }
  rejectUnknown(inventory.stats, STATS_FIELDS, "inventory.stats");
  for (const field of STATS_FIELDS) {
    if (!Number.isInteger(inventory.stats[field]) || inventory.stats[field] < 0) {
      throw new Error(`inventory.stats.${field} must be a non-negative integer`);
    }
  }
  if (inventory.files.length > inventory.limits.max_files || inventory.evidence.length > inventory.limits.max_evidence) {
    throw new Error("inventory exceeds its declared limits");
  }
  if (inventory.stats.safe_files !== inventory.files.length) throw new Error("inventory safe_files count is inconsistent");
  if (!inventory.truncated && inventory.truncation_reasons.length > 0) {
    throw new Error("non-truncated inventory has truncation reasons");
  }
  if (inventory.truncated && inventory.truncation_reasons.length === 0) {
    throw new Error("truncated inventory has no truncation reason");
  }

  const byPath = new Map();
  for (const [index, file] of inventory.files.entries()) {
    rejectUnknown(file, ["path", "kind", "bytes", "line_count", "sha256"], `inventory.files[${index}]`);
    if (
      typeof file.path !== "string" ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 0 ||
      !Number.isInteger(file.line_count) ||
      file.line_count < 1 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`inventory.files[${index}] is invalid`);
    }
    if (byPath.has(file.path)) throw new Error(`inventory contains duplicate file path: ${file.path}`);
    const { buffer } = assertEligibleInventoryPath(root, file.path, inventory.limits.max_bytes_per_file);
    const lineCount = buffer.toString("utf8").split(/\r?\n/).length;
    if (buffer.byteLength !== file.bytes || sha256(buffer) !== file.sha256 || lineCount !== file.line_count) {
      throw new Error(`inventory source changed after scan: ${file.path}`);
    }
    byPath.set(file.path, file);
  }

  for (const [index, item] of inventory.evidence.entries()) {
    rejectUnknown(item, ["kind", "path", "line_start", "line_end", "text"], `inventory.evidence[${index}]`);
    const file = byPath.get(item.path);
    if (
      !file ||
      typeof item.kind !== "string" ||
      !Number.isInteger(item.line_start) ||
      !Number.isInteger(item.line_end) ||
      item.line_start < 1 ||
      item.line_end < item.line_start ||
      item.line_end > file.line_count ||
      typeof item.text !== "string"
    ) {
      throw new Error(`inventory.evidence[${index}] is invalid`);
    }
  }
  return { root, byPath };
}

export function validateInventorySource(source, inventoryState) {
  rejectUnknown(source, ["path", "line_start", "line_end"], "source");
  const file = inventoryState.byPath.get(source.path);
  if (!file) throw new Error(`source path was not read by inventory: ${source.path}`);
  if (
    !Number.isInteger(source.line_start) ||
    !Number.isInteger(source.line_end) ||
    source.line_start < 1 ||
    source.line_end < source.line_start ||
    source.line_end > file.line_count
  ) {
    throw new Error(`source line range is invalid: ${source.path}:${source.line_start}-${source.line_end}`);
  }
  host.resolveSafeRelative(inventoryState.root, source.path);
  return {
    path: source.path,
    line_start: source.line_start,
    line_end: source.line_end,
  };
}
