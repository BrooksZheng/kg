// Black-box regression tests for RFC-004 setup profiles, project documents,
// and brownfield static scanning. Uses disposable hosts only.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "skills", "kg-init", "scripts", "install.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kg-rfc004-"));

function run(script, args, cwd, env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

try {
  const standard = path.join(tempRoot, "standard-host");
  fs.mkdirSync(standard);
  write(path.join(standard, "docs", "glossary.md"), "human glossary\n");

  const firstInstall = run(
    INSTALLER,
    [standard, "--copy", "--docs-profile", "standard", "--project-stage", "brownfield"],
    ROOT,
  );
  assert.match(firstInstall, /created docs\/README\.md/);
  assert.match(firstInstall, /run the kg-scan skill/);
  assert.equal(fs.readFileSync(path.join(standard, "docs", "glossary.md"), "utf8"), "human glossary\n");

  for (const rel of [
    "docs/README.md",
    "docs/architecture/overview.md",
    "docs/decisions/README.md",
    "docs/decisions/0000-template.md",
    "docs/rfcs/README.md",
    "docs/rfcs/0000-template.md",
    "docs/standards/README.md",
    "docs/development.md",
    ".agents/skills/kg-scan/SKILL.md",
    ".agents/skills/kg-scan/scripts/scan-inventory.mjs",
    ".agents/skills/kg-scan/protocol/project-document.schema.yaml",
  ]) {
    assert.equal(exists(standard, rel), true, `standard profile missing ${rel}`);
  }

  const agents = fs.readFileSync(path.join(standard, "AGENTS.md"), "utf8");
  assert.match(agents, /kg-scan\/SKILL\.md/);
  assert.match(agents, /Draft and revise complete ADRs, RFCs, and technical plans directly/);

  const installedInstaller = path.join(standard, ".agents", "skills", "kg-init", "scripts", "install.mjs");
  run(
    installedInstaller,
    ["--docs-profile", "standard", "--project-stage", "brownfield"],
    standard,
  );
  assert.equal(fs.readFileSync(path.join(standard, "docs", "glossary.md"), "utf8"), "human glossary\n");

  const architecture = path.join(standard, "docs", "architecture", "overview.md");
  const acceptedArchitecture = fs
    .readFileSync(architecture, "utf8")
    .replace("status: draft", "status: accepted\naccepted_at: 2026-07-24");
  fs.writeFileSync(architecture, acceptedArchitecture);
  write(path.join(standard, "docs", "notes.md"), "# Ordinary project note\n");

  const validator = path.join(
    standard,
    ".agents",
    "skills",
    "kg-compile",
    "scripts",
    "validate-project-documents.mjs",
  );
  const validation = run(validator, [], standard);
  assert.match(validation, /registered project document\(s\) valid/);
  const accepted = run(validator, ["--list-accepted"], standard).trim().split("\n");
  assert.deepEqual(accepted, ["docs/architecture/overview.md"]);

  const supersededDocument = path.join(standard, "docs", "superseded.md");
  write(
    supersededDocument,
    [
      "---",
      "kind: kg.project_document",
      'title: "Superseded document"',
      "doc_type: decision",
      "status: superseded",
      "accepted_at: 2026-07-20",
      "supersedes: null",
      "superseded_by: docs/decisions/0001-replacement.md",
      "---",
      "",
      "# Superseded document",
      "",
    ].join("\n"),
  );
  assert.match(run(validator, [], standard), /superseded/);
  fs.unlinkSync(supersededDocument);

  const invalidDocument = path.join(standard, "docs", "invalid-accepted.md");
  write(
    invalidDocument,
    [
      "---",
      "kind: kg.project_document",
      'title: "Invalid accepted document"',
      "doc_type: rfc",
      "status: accepted",
      "supersedes: null",
      "---",
      "",
      "# Invalid accepted document",
      "",
    ].join("\n"),
  );
  assert.throws(() => run(validator, [], standard));
  fs.unlinkSync(invalidDocument);

  write(
    path.join(standard, "package.json"),
    JSON.stringify(
      {
        name: "brownfield-fixture",
        scripts: {
          test: "node should-not-run.mjs",
          dev: "node src/server.mjs",
        },
      },
      null,
      2,
    ),
  );
  write(path.join(standard, "should-not-run.mjs"), "throw new Error('scan executed host code');\n");
  write(
    path.join(standard, "src", "routes.ts"),
    [
      "export interface OrderRequest { id: string }",
      "export function registerOrderRoutes(router) {",
      "  router.get('/orders/:id', getOrder);",
      "}",
      "",
    ].join("\n"),
  );
  write(path.join(standard, "src", "order-schema.sql"), "CREATE TABLE orders (id text primary key);\n");
  write(path.join(standard, ".env"), "SECRET_TOKEN=must-not-appear\n");
  write(path.join(standard, ".npmrc"), "//registry.example.test/:_authToken=hidden-npm-token\n");
  write(path.join(standard, "secrets", "notes.txt"), "hidden-directory-secret\n");
  write(path.join(standard, ".kg", "private-test.yaml"), "hidden-project-claim\n");
  fs.symlinkSync(path.join(standard, "src"), path.join(standard, "linked-src"));

  const scanner = path.join(
    standard,
    ".agents",
    "skills",
    "kg-scan",
    "scripts",
    "scan-inventory.mjs",
  );
  const scanText = run(scanner, [standard, "--format", "json"], standard);
  const scan = JSON.parse(scanText);
  assert.equal(scan.kind, "kg.scan_inventory");
  assert.equal(scan.static_only, true);
  assert.equal(scan.truncated, false);
  assert.ok(scan.languages.some((item) => item.language === "TypeScript"));
  assert.ok(scan.commands.some((item) => item.name === "test"));
  assert.ok(scan.api_hints.some((item) => item.kind === "http_route" && item.ref === "src/routes.ts:3"));
  assert.ok(scan.schema_hints.some((item) => item.ref === "src/order-schema.sql:1"));
  assert.ok(scan.public_symbols.some((item) => item.name === "OrderRequest"));
  assert.ok(scan.stats.excluded_sensitive_directories >= 1);
  assert.ok(scan.stats.excluded_sensitive_files >= 2);
  assert.ok(scan.stats.skipped_symlinks >= 1);
  assert.equal(scanText.includes("hidden-project-claim"), false);
  assert.equal(scanText.includes("hidden-directory-secret"), false);
  assert.equal(scanText.includes("hidden-npm-token"), false);
  assert.equal(exists(standard, "scan-executed-host-code"), false);

  const lean = path.join(tempRoot, "lean-host");
  fs.mkdirSync(lean);
  run(INSTALLER, [lean, "--copy", "--docs-profile", "lean"], ROOT);
  assert.equal(exists(lean, "docs/architecture/overview.md"), true);
  assert.equal(exists(lean, "docs/rfcs/0000-template.md"), false);
  assert.equal(exists(lean, "docs/standards/README.md"), false);
  assert.equal(exists(lean, "docs/development.md"), false);

  const none = path.join(tempRoot, "none-host");
  fs.mkdirSync(none);
  run(INSTALLER, [none, "--copy", "--docs-profile", "none"], ROOT);
  assert.equal(exists(none, "docs/README.md"), false);

  const symlinked = path.join(tempRoot, "symlink-host");
  fs.mkdirSync(path.join(symlinked, ".claude"), { recursive: true });
  run(INSTALLER, [symlinked, "--docs-profile", "lean", "--project-stage", "brownfield"], ROOT);
  const agentScanLink = path.join(symlinked, ".agents", "skills", "kg-scan");
  const claudeScanLink = path.join(symlinked, ".claude", "skills", "kg-scan");
  assert.equal(fs.lstatSync(agentScanLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(claudeScanLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(agentScanLink), path.join(ROOT, "skills", "kg-scan"));
  assert.equal(fs.realpathSync(claudeScanLink), path.join(ROOT, "skills", "kg-scan"));
  assert.match(fs.readFileSync(path.join(symlinked, "CLAUDE.md"), "utf8"), /@AGENTS\.md/);

  console.log("RFC-004 black-box tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
