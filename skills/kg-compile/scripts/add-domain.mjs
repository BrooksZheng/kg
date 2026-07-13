// Append a domain to protocol/domains.yaml after a human accepts a
// kind: proposal queue ruling (RFC-002 S2). Logs the action for metrics.
//
// Usage: node skills/kg-compile/scripts/add-domain.mjs <name> "<description>"
//
// The domain name must be a lowercase identifier (a-z, 0-9, hyphen).
// Re-run validate-knowledge.mjs after adding domains used by pending drafts.

import { protocol, host } from "./_lib.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const name = args[0];
const description = args[1];
if (!name || !description) host.fail('usage: add-domain.mjs <name> "<description>"');

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  host.fail("domain name must match ^[a-z][a-z0-9-]*$ (lowercase identifier)");
}

const hostRoot = host.findHostRoot();
const paths = host.kgPaths(hostRoot);

const vocab = protocol.loadDomains();
if (vocab.domains?.[name]) host.fail(`domain \`${name}\` already exists in protocol/domains.yaml`);

vocab.domains ??= {};
vocab.domains[name] = { description };
const file = protocol.saveDomains(vocab);
host.appendRoundAction(paths, { action: "add_domain", domain: name });

console.log(`kg: added domain \`${name}\` -> ${file}`);
console.log("kg: run node scripts/sync-vendored.mjs (plugin source) to refresh embedded copies.");
