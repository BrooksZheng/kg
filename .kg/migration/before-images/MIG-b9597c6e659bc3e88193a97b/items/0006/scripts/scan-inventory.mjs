#!/usr/bin/env node

// Static, read-only brownfield inventory for kg-scan (RFC-004).
// It never executes host code, follows no symlinks, and always excludes .kg.
//
// Usage:
//   node scan-inventory.mjs [root] [--format json|markdown]
//     [--max-files N] [--max-bytes N] [--max-hints N]
//     [--exclude relative/path]...

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function positiveInteger(name, fallback) {
  const raw = option(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} needs a positive integer`);
  return value;
}

function repeatedOption(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values.filter(Boolean).map(normalizeRelative);
}

const valueFlags = new Set(["--format", "--max-files", "--max-bytes", "--max-hints", "--exclude"]);
const positional = args.filter((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1]));
const root = path.resolve(positional[0] ?? process.cwd());
const format = option("--format", "json");
const maxFiles = positiveInteger("--max-files", 5000);
const maxBytes = positiveInteger("--max-bytes", 512000);
const maxHints = positiveInteger("--max-hints", 200);
const customExcludes = repeatedOption("--exclude");

if (!["json", "markdown"].includes(format)) fail("--format must be json or markdown");
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`scan root is not a directory: ${root}`);

const EXCLUDED_DIRS = new Set([
  ".git",
  ".kg",
  ".agents",
  ".claude",
  ".cache",
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
  "gen",
  "knowledge",
  "node_modules",
  "out",
  "pods",
  "target",
  "vendor",
  "venv",
]);

const SENSITIVE_DIRS = new Set([
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

const LANGUAGE_BY_EXTENSION = new Map([
  [".c", "C"],
  [".cc", "C++"],
  [".cpp", "C++"],
  [".cs", "C#"],
  [".go", "Go"],
  [".h", "C/C++ header"],
  [".hpp", "C++ header"],
  [".java", "Java"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript JSX"],
  [".kt", "Kotlin"],
  [".kts", "Kotlin"],
  [".mjs", "JavaScript"],
  [".php", "PHP"],
  [".py", "Python"],
  [".rb", "Ruby"],
  [".rs", "Rust"],
  [".scala", "Scala"],
  [".sh", "Shell"],
  [".swift", "Swift"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript TSX"],
]);

const GENERIC_TERMS = new Set([
  "app",
  "base",
  "common",
  "component",
  "components",
  "config",
  "controller",
  "controllers",
  "core",
  "data",
  "default",
  "generated",
  "handler",
  "handlers",
  "helper",
  "helpers",
  "index",
  "internal",
  "lib",
  "main",
  "manager",
  "model",
  "models",
  "module",
  "package",
  "request",
  "response",
  "route",
  "routes",
  "schema",
  "schemas",
  "service",
  "services",
  "shared",
  "spec",
  "src",
  "test",
  "tests",
  "type",
  "types",
  "util",
  "utils",
]);

const stats = {
  excluded_directories: 0,
  excluded_sensitive_directories: 0,
  excluded_sensitive_files: 0,
  oversized_files: 0,
  skipped_binary_files: 0,
  skipped_symlinks: 0,
};

const files = [];
let truncated = false;

function fail(message) {
  console.error(`kg-scan: error: ${message}`);
  process.exit(1);
}

function normalizeRelative(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isCustomExcluded(rel) {
  const normalized = normalizeRelative(rel);
  return customExcludes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function isSensitive(name) {
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
    [".db", ".der", ".jks", ".kdbx", ".key", ".keystore", ".ovpn", ".p12", ".pem", ".pfx", ".sqlite", ".sqlite3"].some((ext) =>
      lower.endsWith(ext),
    )
  );
}

function isTextFile(name) {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.has(path.extname(lower)) || SPECIAL_TEXT_FILES.has(lower);
}

function walk(dir) {
  if (truncated) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (truncated) return;
    const full = path.join(dir, entry.name);
    const rel = normalizeRelative(path.relative(root, full));
    if (entry.isSymbolicLink()) {
      stats.skipped_symlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const lowerName = entry.name.toLowerCase();
      if (SENSITIVE_DIRS.has(lowerName)) {
        stats.excluded_sensitive_directories += 1;
        continue;
      }
      if (EXCLUDED_DIRS.has(lowerName) || isCustomExcluded(rel)) {
        stats.excluded_directories += 1;
        continue;
      }
      walk(full);
      continue;
    }
    if (!entry.isFile() || isCustomExcluded(rel)) continue;
    if (isSensitive(entry.name)) {
      stats.excluded_sensitive_files += 1;
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    const size = fs.statSync(full).size;
    const text = isTextFile(entry.name);
    if (!text) stats.skipped_binary_files += 1;
    else if (size > maxBytes) stats.oversized_files += 1;
    files.push({ full, rel, name: entry.name, size, text: text && size <= maxBytes });
  }
}

walk(root);

function readSafe(file) {
  if (!file.text) return null;
  try {
    return fs.readFileSync(file.full, "utf8");
  } catch {
    return null;
  }
}

function redact(value) {
  return String(value)
    .replace(/(token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2<redacted>")
    .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, "://<redacted>:<redacted>@")
    .slice(0, 240);
}

function ref(file, line, text) {
  return { ref: `${file.rel}:${line}`, text: redact(text.trim()) };
}

const languages = new Map();
const manifests = [];
const existingDocs = [];
const commands = [];
const apiHints = [];
const publicSymbols = [];
const schemaHints = [];
const termMap = new Map();
const directoryCounts = new Map();

function pushLimited(list, item) {
  if (list.length < maxHints) list.push(item);
}

function addTerm(term, file) {
  const normalized = term.toLowerCase();
  if (normalized.length < 3 || GENERIC_TERMS.has(normalized) || /^\d+$/.test(normalized)) return;
  let value = termMap.get(normalized);
  if (!value) {
    value = { term: normalized, count: 0, refs: [] };
    termMap.set(normalized, value);
  }
  value.count += 1;
  if (value.refs.length < 5 && !value.refs.includes(file.rel)) value.refs.push(file.rel);
}

function tokenizeName(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

for (const file of files) {
  const extension = path.extname(file.name.toLowerCase());
  const language = LANGUAGE_BY_EXTENSION.get(extension);
  if (language) languages.set(language, (languages.get(language) ?? 0) + 1);

  const firstDir = file.rel.includes("/") ? file.rel.split("/")[0] : "(root)";
  directoryCounts.set(firstDir, (directoryCounts.get(firstDir) ?? 0) + 1);

  const lowerName = file.name.toLowerCase();
  if (MANIFEST_NAMES.has(lowerName)) manifests.push(file.rel);
  if (extension === ".md") {
    let type = "documentation";
    if (/(^|\/)(adr|adrs|decision|decisions)(\/|$)/i.test(file.rel)) type = "decision";
    else if (/(^|\/)(rfc|rfcs|proposal|proposals)(\/|$)/i.test(file.rel)) type = "proposal";
    else if (/(^|\/)(runbook|runbooks|operations|ops)(\/|$)/i.test(file.rel)) type = "runbook";
    existingDocs.push({ path: file.rel, type });
  }

  for (const token of new Set(tokenizeName(file.name))) addTerm(token, file);

  const content = readSafe(file);
  if (content === null) continue;
  const lines = content.split(/\r?\n/);

  if (lowerName === "package.json") {
    try {
      const parsed = JSON.parse(content);
      if (parsed.scripts && typeof parsed.scripts === "object") {
        for (const [name, command] of Object.entries(parsed.scripts)) {
          pushLimited(commands, { name, command: redact(command), ref: file.rel });
        }
      }
    } catch {
      pushLimited(schemaHints, { kind: "invalid_json_manifest", ref: file.rel, text: "package.json could not be parsed" });
    }
  }

  if (lowerName === "makefile" || lowerName === "justfile") {
    lines.forEach((line, index) => {
      const match = /^([A-Za-z0-9_.-]+):(?:\s|$)/.exec(line);
      if (match && !match[1].startsWith(".")) {
        pushLimited(commands, { name: match[1], command: `${lowerName === "makefile" ? "make" : "just"} ${match[1]}`, ref: `${file.rel}:${index + 1}` });
      }
    });
  }

  const pathSignalsApi = /(^|\/)(api|apis|controller|controllers|endpoint|endpoints|handler|handlers|openapi|route|routes|swagger)(\/|\.|-)/i.test(
    file.rel,
  );
  if (pathSignalsApi) pushLimited(apiHints, { kind: "api_path", ref: file.rel, text: "path name suggests an API surface" });

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const routePatterns = [
      /\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/i,
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
      /\bHandleFunc\s*\(\s*"([^"]+)"/,
      /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/,
    ];
    for (const pattern of routePatterns) {
      if (pattern.test(line)) {
        pushLimited(apiHints, { kind: "http_route", ...ref(file, lineNumber, line) });
        break;
      }
    }

    const symbolPatterns = [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:public\s+)?(?:class|interface|record|enum)\s+([A-Z][A-Za-z0-9_]*)/,
      /^(?:type|func|var|const)\s+([A-Z][A-Za-z0-9_]*)/,
      /^\s*public\s+(?:class|struct|enum|protocol|func|var|let)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    ];
    for (const pattern of symbolPatterns) {
      const match = pattern.exec(line);
      if (match) {
        pushLimited(publicSymbols, { name: match[1], ...ref(file, lineNumber, line) });
        for (const token of tokenizeName(match[1])) addTerm(token, file);
        break;
      }
    }

    if (
      /^\s*(?:message|service|type|input|enum)\s+[A-Za-z_][A-Za-z0-9_]*/.test(line) ||
      /\bCREATE\s+TABLE\b/i.test(line) ||
      /["']\$schema["']\s*:/.test(line) ||
      /\bz\.object\s*\(/.test(line)
    ) {
      pushLimited(schemaHints, { kind: "schema", ...ref(file, lineNumber, line) });
    }
  });
}

const termHints = [...termMap.values()]
  .filter((item) => item.count >= 2)
  .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  .slice(0, Math.min(maxHints, 80));

const inventory = {
  kind: "kg.scan_inventory",
  version: 1,
  root: path.basename(root),
  scanned_at: new Date().toISOString(),
  static_only: true,
  limits: { max_files: maxFiles, max_bytes_per_file: maxBytes, max_hints: maxHints },
  truncated,
  stats: { files_seen: files.length, ...stats },
  directory_summary: [...directoryCounts.entries()]
    .map(([directory, count]) => ({ directory, count }))
    .sort((a, b) => b.count - a.count || a.directory.localeCompare(b.directory)),
  languages: [...languages.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
  manifests: manifests.sort(),
  commands,
  existing_documents: existingDocs.sort((a, b) => a.path.localeCompare(b.path)),
  api_hints: apiHints,
  public_symbols: publicSymbols,
  schema_hints: schemaHints,
  term_hints: termHints,
};

function markdown(data) {
  const lines = [
    "# KG brownfield static inventory",
    "",
    `- Root: \`${data.root}\``,
    `- Scanned at: ${data.scanned_at}`,
    `- Files seen: ${data.stats.files_seen}`,
    `- Static only: ${data.static_only}`,
    `- Truncated: ${data.truncated}`,
    "",
    "## Languages",
    "",
    ...data.languages.map((item) => `- ${item.language}: ${item.files} file(s)`),
    "",
    "## Manifests",
    "",
    ...data.manifests.map((item) => `- \`${item}\``),
    "",
    "## Commands",
    "",
    ...data.commands.map((item) => `- \`${item.name}\`: \`${item.command}\` (${item.ref})`),
    "",
    "## Existing documents",
    "",
    ...data.existing_documents.map((item) => `- ${item.type}: \`${item.path}\``),
    "",
    "## API hints",
    "",
    ...data.api_hints.map((item) => `- ${item.kind}: \`${item.ref}\` ${item.text}`),
    "",
    "## Public symbols",
    "",
    ...data.public_symbols.map((item) => `- \`${item.name}\` at \`${item.ref}\``),
    "",
    "## Schema hints",
    "",
    ...data.schema_hints.map((item) => `- ${item.kind}: \`${item.ref}\` ${item.text}`),
    "",
    "## Term hints",
    "",
    ...data.term_hints.map((item) => `- \`${item.term}\` (${item.count} signals): ${item.refs.map((value) => `\`${value}\``).join(", ")}`),
    "",
    "## Safety exclusions",
    "",
    `- Excluded directories: ${data.stats.excluded_directories}`,
    `- Excluded sensitive directories: ${data.stats.excluded_sensitive_directories}`,
    `- Excluded sensitive files: ${data.stats.excluded_sensitive_files}`,
    `- Oversized text files: ${data.stats.oversized_files}`,
    `- Skipped binary files: ${data.stats.skipped_binary_files}`,
    `- Skipped symlinks: ${data.stats.skipped_symlinks}`,
  ];
  return `${lines.join("\n")}\n`;
}

process.stdout.write(format === "json" ? `${JSON.stringify(inventory, null, 2)}\n` : markdown(inventory));
