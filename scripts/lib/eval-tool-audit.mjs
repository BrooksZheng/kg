import path from "node:path";

const SHELL_TOOL_TOKENS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "shell",
  "powershell",
  "pwsh",
  "terminal",
  "cmd",
  "exec",
]);

const NODE_OPTIONS_WITH_VALUES = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "--inspect-port",
  "--diagnostic-dir",
  "--icu-data-dir",
  "--openssl-config",
  "--redirect-warnings",
  "--title",
  "--env-file",
  "--env-file-if-exists",
]);

const NODE_NON_SCRIPT_MODES = new Set(["-e", "--eval", "-p", "--print", "-c", "--check", "--test"]);

export function normalizedToolName(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function isShellToolName(name) {
  return normalizedToolName(name)
    .split(" ")
    .filter(Boolean)
    .some((token) => SHELL_TOOL_TOKENS.has(token));
}

export function isUserInteractionToolName(name) {
  const normalized = normalizedToolName(name);
  return /\b(?:ask|question)\b/.test(normalized) || /\brequest user input\b/.test(normalized);
}

function shellTokens(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;

  for (const character of String(command ?? "")) {
    if (escaping) {
      if (character !== "\n") token += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token !== "") tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (escaping) token += "\\";
  if (token !== "") tokens.push(token);
  return tokens;
}

function isNodeExecutable(token) {
  const basename = path.posix.basename(String(token).replaceAll("\\", "/")).toLowerCase();
  return basename === "node" || basename === "nodejs";
}

function nodeScriptToken(tokens, nodeIndex) {
  for (let index = nodeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return tokens[index + 1] ?? null;
    if (NODE_NON_SCRIPT_MODES.has(token) || token.startsWith("--eval=") || token.startsWith("--print=")) {
      return null;
    }
    if (NODE_OPTIONS_WITH_VALUES.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function sameScriptName(candidate, scriptPath) {
  const basename = (value) => path.posix.basename(String(value).replaceAll("\\", "/"));
  return basename(candidate) === basename(scriptPath);
}

export function isScriptInvocation(event, scriptPath) {
  if (event?.ok !== true || typeof event?.command !== "string" || !isShellToolName(event?.name)) return false;
  if (typeof scriptPath !== "string" || scriptPath.trim() === "") return false;
  const tokens = shellTokens(event.command);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isNodeExecutable(tokens[index])) continue;
    const candidate = nodeScriptToken(tokens, index);
    if (candidate !== null && sameScriptName(candidate, scriptPath)) return true;
  }
  return false;
}

export function scriptInvocationEvents(events, scriptPath) {
  return (Array.isArray(events) ? events : []).filter((event) => isScriptInvocation(event, scriptPath));
}

export function countScriptInvocations(events, scriptPath) {
  return scriptInvocationEvents(events, scriptPath).length;
}

// Tool events preserve absolute paths where runner `file_reads` are relativized
// to the project root, so a read of a product outside that root is only visible
// here (D52). Callers pass a canonicalizer rather than importing host, keeping
// this module free of host-layout assumptions.
export function commandPathTokens(command) {
  return (String(command).match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [])
    .map((token) => token.replace(/^[("'`]+/, "").replace(/[)"'`,;]+$/, ""))
    .filter(Boolean);
}

export function hasProductReadEvidence(response, productFile, canonicalPath) {
  const basename = productFile.split("/").pop();
  const canonicalProduct = canonicalPath(productFile);
  return (response?.tool_events ?? []).some((event) => {
    if (event?.ok !== true || !normalizedToolName(event?.name).split(" ").includes("read")) return false;
    return commandPathTokens(event.command).some((token) => {
      if (token.startsWith("/")) return canonicalPath(token) === canonicalProduct;
      return token.split("/").pop() === basename;
    });
  });
}
