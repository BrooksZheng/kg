// KYAML — the strict YAML subset used by every kg machine-parsed surface
// (protocol files, .kg/config.yaml, observations, queue items, knowledge
// frontmatter, compile action manifests). Implemented on Node stdlib only.
//
// Spec (also documented in README.md):
//   - UTF-8 text; a document is a block mapping.
//   - Comments: whole lines whose first non-space character is `#`.
//     No trailing comments after values. Blank lines are ignored.
//   - Indentation: exactly 2 spaces per level. No tabs.
//   - Block mapping entries: `key: value` or `key:` followed by an indented
//     block (mapping or list). Keys are bare: [A-Za-z0-9_.\[\]-]+.
//   - Block lists: `- <value>` lines; each item fits on one line.
//   - Inline lists `[a, b]` and inline maps `{ k: v }` hold scalars only.
//   - Scalars: double-quoted JSON strings, or bare tokens
//     (null | ~ | true | false | number | plain string).
//     Bare scalars must not contain `#`; quote anything unusual.
//   - NOT supported: anchors, tags, multi-line scalars, nested inline
//     collections, flow mappings spanning lines.

export class KyamlError extends Error {}

const KEY_RE = /^([A-Za-z0-9_.\-\[\]]+):(?:[ ](.*))?$/;

export function parse(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.includes("\t")) throw new KyamlError(`line ${i + 1}: tabs are not allowed`);
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const spaces = line.length - trimmed.length;
    if (spaces % 2 !== 0) throw new KyamlError(`line ${i + 1}: indentation must be a multiple of 2 spaces`);
    lines.push({ n: i + 1, indent: spaces / 2, text: trimmed.trimEnd() });
  }
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    throw new KyamlError(`line ${lines[next].n}: unexpected content (bad indentation?)`);
  }
  return value;
}

function parseBlock(lines, idx, indent) {
  if (lines[idx].text.startsWith("- ") || lines[idx].text === "-") {
    return parseList(lines, idx, indent);
  }
  return parseMap(lines, idx, indent);
}

function parseMap(lines, idx, indent) {
  const out = {};
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const { n, text } = lines[i];
    if (text.startsWith("- ")) break;
    const m = KEY_RE.exec(text);
    if (!m) throw new KyamlError(`line ${n}: expected \`key: value\` or \`key:\`, got: ${text}`);
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new KyamlError(`line ${n}: duplicate key \`${key}\``);
    }
    if (m[2] !== undefined && m[2] !== "") {
      out[key] = parseInlineValue(m[2], n);
      i += 1;
    } else {
      // `key:` — expect an indented block, else null.
      if (i + 1 < lines.length && lines[i + 1].indent === indent + 1) {
        const [value, next] = parseBlock(lines, i + 1, indent + 1);
        out[key] = value;
        i = next;
      } else if (i + 1 < lines.length && lines[i + 1].indent > indent + 1) {
        throw new KyamlError(`line ${lines[i + 1].n}: over-indented block (expected ${(indent + 1) * 2} spaces)`);
      } else {
        out[key] = null;
        i += 1;
      }
    }
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new KyamlError(`line ${lines[i].n}: unexpected indentation`);
  }
  return [out, i];
}

function parseList(lines, idx, indent) {
  const out = [];
  let i = idx;
  while (i < lines.length && lines[i].indent === indent) {
    const { n, text } = lines[i];
    if (!text.startsWith("- ")) break;
    out.push(parseInlineValue(text.slice(2), n));
    i += 1;
  }
  if (i < lines.length && lines[i].indent > indent) {
    throw new KyamlError(`line ${lines[i].n}: multi-line list items are not supported`);
  }
  return [out, i];
}

function parseInlineValue(s, n) {
  const t = s.trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new KyamlError(`line ${n}: inline list must close on the same line`);
    return splitItems(t.slice(1, -1), n).map((item) => parseScalar(item, n));
  }
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw new KyamlError(`line ${n}: inline map must close on the same line`);
    const out = {};
    for (const item of splitItems(t.slice(1, -1), n)) {
      const ci = findUnquoted(item, ":");
      if (ci < 0) throw new KyamlError(`line ${n}: inline map item missing \`:\` — ${item}`);
      const key = item.slice(0, ci).trim();
      if (!/^[A-Za-z0-9_.\-]+$/.test(key)) throw new KyamlError(`line ${n}: bad inline map key \`${key}\``);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new KyamlError(`line ${n}: duplicate inline key \`${key}\``);
      out[key] = parseScalar(item.slice(ci + 1).trim(), n);
    }
    return out;
  }
  return parseScalar(t, n);
}

// Split `a, b, c` on commas that are outside double quotes.
function splitItems(inner, n) {
  const items = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQ) {
      cur += c;
      if (c === "\\") cur += inner[++i] ?? "";
      else if (c === '"') inQ = false;
    } else if (c === '"') {
      inQ = true;
      cur += c;
    } else if (c === "," ) {
      items.push(cur);
      cur = "";
    } else if (c === "[" || c === "]" || c === "{" || c === "}") {
      throw new KyamlError(`line ${n}: nested inline collections are not supported`);
    } else {
      cur += c;
    }
  }
  if (inQ) throw new KyamlError(`line ${n}: unterminated string`);
  if (cur.trim() !== "" || items.length > 0) items.push(cur);
  const trimmed = items.map((x) => x.trim());
  if (trimmed.length === 1 && trimmed[0] === "") return [];
  if (trimmed.some((x) => x === "")) throw new KyamlError(`line ${n}: empty inline item`);
  return trimmed;
}

function findUnquoted(s, ch) {
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === "\\") i += 1;
      else if (c === '"') inQ = false;
    } else if (c === '"') inQ = true;
    else if (c === ch) return i;
  }
  return -1;
}

function parseScalar(t, n) {
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t);
      if (typeof v !== "string") throw new Error("not a string");
      return v;
    } catch {
      throw new KyamlError(`line ${n}: invalid quoted string: ${t}`);
    }
  }
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t);
  if (t.includes("#")) throw new KyamlError(`line ${n}: \`#\` in a bare scalar — use a double-quoted string`);
  if (t.includes('"')) throw new KyamlError(`line ${n}: stray quote in bare scalar — quote the whole value`);
  return t;
}

// ---------------------------------------------------------------------------

const BARE_SCALAR_RE = /^[A-Za-z0-9_@./:+-]+$/;

function scalarStr(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  const reserved = s === "null" || s === "~" || s === "true" || s === "false" || /^-?\d+(\.\d+)?$/.test(s);
  if (s !== "" && BARE_SCALAR_RE.test(s) && !reserved) return s;
  return JSON.stringify(s);
}

function isScalar(v) {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function stringify(obj) {
  if (!isPlainObject(obj)) throw new KyamlError("stringify: document root must be a mapping");
  return stringifyMap(obj, 0) + "\n";
}

function stringifyMap(obj, indent) {
  const pad = "  ".repeat(indent);
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z0-9_.\-\[\]]+$/.test(key)) throw new KyamlError(`stringify: bad key \`${key}\``);
    if (isScalar(value)) {
      out.push(`${pad}${key}: ${scalarStr(value)}`);
    } else if (Array.isArray(value)) {
      out.push(...stringifyList(key, value, indent));
    } else if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        out.push(`${pad}${key}: {}`);
      } else if (Object.values(value).every(isScalar) && inlineMapStr(value).length <= 76) {
        out.push(`${pad}${key}: ${inlineMapStr(value)}`);
      } else {
        out.push(`${pad}${key}:`);
        out.push(stringifyMap(value, indent + 1));
      }
    } else {
      throw new KyamlError(`stringify: unsupported value for \`${key}\``);
    }
  }
  return out.join("\n");
}

function stringifyList(key, list, indent) {
  const pad = "  ".repeat(indent);
  if (list.length === 0) return [`${pad}${key}: []`];
  if (list.every(isScalar)) {
    const inline = `[${list.map(scalarStr).join(", ")}]`;
    if (inline.length <= 60) return [`${pad}${key}: ${inline}`];
    return [`${pad}${key}:`, ...list.map((v) => `${pad}  - ${scalarStr(v)}`)];
  }
  if (list.every(isPlainObject)) {
    const out = [`${pad}${key}:`];
    for (const item of list) {
      if (!Object.values(item).every(isScalar)) {
        throw new KyamlError(`stringify: list items under \`${key}\` must be flat maps of scalars`);
      }
      out.push(`${pad}  - ${inlineMapStr(item)}`);
    }
    return out;
  }
  throw new KyamlError(`stringify: mixed list under \`${key}\``);
}

function inlineMapStr(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${scalarStr(v)}`);
  return `{ ${parts.join(", ")} }`;
}
