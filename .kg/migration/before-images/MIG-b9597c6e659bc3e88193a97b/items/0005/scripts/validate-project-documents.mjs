// Validate opt-in project documents against
// protocol/project-document.schema.yaml (RFC-004).
//
// Ordinary Markdown files are intentionally ignored. A file enters this
// contract only when its frontmatter declares `kind: kg.project_document`.
//
// Usage:
//   node validate-project-documents.mjs
//   node validate-project-documents.mjs <file>...
//   node validate-project-documents.mjs --list-accepted

import fs from "node:fs";
import path from "node:path";
import { protocol, host } from "./_lib.mjs";

const rawArgs = process.argv.slice(2);
const listAccepted = rawArgs.includes("--list-accepted");
const fileArgs = rawArgs.filter((arg) => !arg.startsWith("--"));
const hostRoot = host.findHostRoot();
const docsRoot = path.join(hostRoot, "docs");

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

const files = fileArgs.length ? fileArgs.map((file) => path.resolve(file)) : listMarkdown(docsRoot);
const schema = protocol.loadProjectDocumentSchema();
let bad = 0;
let registered = 0;
let ordinary = 0;
const accepted = [];

for (const file of files) {
  const label = path.relative(hostRoot, file) || file;
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) {
    ordinary += 1;
    continue;
  }

  let frontmatter;
  let body;
  try {
    ({ frontmatter, body } = protocol.splitFrontmatter(text));
  } catch (err) {
    if (/^kind:[ ]+kg\.project_document[ ]*$/m.test(text.split(/\r?\n/).slice(0, 30).join("\n"))) {
      bad += 1;
      if (!listAccepted) {
        console.error(`FAIL ${label}`);
        console.error(`  - ${err.message}`);
      }
    } else {
      ordinary += 1;
    }
    continue;
  }

  if (frontmatter.kind !== "kg.project_document") {
    ordinary += 1;
    continue;
  }

  registered += 1;
  const errors = protocol.validateRecord(frontmatter, schema);
  const hasAcceptanceHistory = frontmatter.status === "accepted" || frontmatter.status === "superseded";
  if (hasAcceptanceHistory && !frontmatter.accepted_at) {
    errors.push(`status is \`${frontmatter.status}\` but \`accepted_at\` is missing`);
  }
  if (!hasAcceptanceHistory && frontmatter.accepted_at) {
    errors.push("`accepted_at` is set without accepted document history");
  }
  if (frontmatter.status === "superseded" && !frontmatter.superseded_by) {
    errors.push("status is `superseded` but `superseded_by` is missing");
  }
  if (frontmatter.status !== "superseded" && frontmatter.superseded_by) {
    errors.push("`superseded_by` is set while status is not `superseded`");
  }
  if (body.trim() === "") errors.push("document body is empty");

  if (errors.length) {
    bad += 1;
    if (!listAccepted) {
      console.error(`FAIL ${label}`);
      for (const error of errors) console.error(`  - ${error}`);
    }
    continue;
  }

  if (frontmatter.status === "accepted") accepted.push(file);
  if (!listAccepted) console.log(`ok   ${label} (${frontmatter.status})`);
}

if (listAccepted) {
  if (bad) process.exit(1);
  for (const file of accepted) console.log(path.relative(hostRoot, file));
  process.exit(0);
}

console.log(
  `kg: ${registered - bad}/${registered} registered project document(s) valid; ` +
    `${accepted.length} accepted; ${ordinary} ordinary Markdown file(s) ignored`,
);
process.exit(bad ? 1 : 0);
