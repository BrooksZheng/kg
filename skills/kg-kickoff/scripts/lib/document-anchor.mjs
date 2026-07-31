// Stable project-document anchor validation shared by kg skill scripts.
// Callers choose their own user-facing error wording from the structured
// error code, while path and filesystem policy stay centralized here.

import fs from "node:fs";
import path from "node:path";
import * as host from "./host.mjs";

const STABLE_DOCUMENT_PATH_RE = /^(docs\/.+\.md|knowledge\/KN-[^/]+\.md|AGENTS\.md)$/;
const STABLE_DOCUMENT_ANCHOR_RE = /^(docs\/.+\.md|knowledge\/KN-[^/]+\.md|AGENTS\.md)#L([1-9][0-9]*)$/;

export class DocumentAnchorError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "DocumentAnchorError";
    this.code = code;
    this.details = details;
  }
}

function reject(code, details) {
  throw new DocumentAnchorError(code, details);
}

function ensureNoSymlink(root, rel) {
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) reject("symbolic_link", { sourcePath: rel });
  }
}

export function validateStableDocumentReference({ sourcePath, line, projectRoot }) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    reject("path_required", { sourcePath });
  }
  if (path.isAbsolute(sourcePath) || sourcePath.includes("\\")) {
    reject("path_not_normalized", { sourcePath });
  }

  const portable = sourcePath.replaceAll("\\", "/");
  const segments = portable.split("/");
  const normalized = path.posix.normalize(portable);
  const normalizedLower = normalized.toLowerCase();
  if (
    segments.includes("..") ||
    normalized !== portable ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    reject("path_not_normalized", { sourcePath });
  }
  if (normalizedLower.split("/").includes(".kg")) {
    reject("isolated_path", { sourcePath });
  }
  if (!STABLE_DOCUMENT_PATH_RE.test(normalized)) {
    reject("not_stable_document", { sourcePath });
  }

  const root = host.canonicalPath(projectRoot);
  const full = path.resolve(root, ...normalized.split("/"));
  if (host.isOutside(root, full)) {
    reject("outside_project", { sourcePath });
  }
  ensureNoSymlink(root, normalized);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    reject("file_missing", { sourcePath: normalized });
  }

  let lineCount = null;
  if (line !== undefined) {
    if (!Number.isInteger(line) || line < 1) reject("line_invalid", { sourcePath: normalized, line });
    const text = fs.readFileSync(full, "utf8");
    lineCount = text === "" ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
    if (line > lineCount) reject("line_exceeds", { sourcePath: normalized, line, lineCount });
  }

  return { sourcePath: normalized, line, lineCount, full };
}

export function validateConstraintAnchor(source, projectRoot, pattern) {
  if (!new RegExp(pattern).test(source)) {
    throw new Error(`constraint source must be a stable document anchor: ${source}`);
  }
  const match = STABLE_DOCUMENT_ANCHOR_RE.exec(source);
  if (!match) throw new Error(`constraint source anchor is malformed: ${source}`);
  const sourcePath = match[1];
  const line = Number.parseInt(match[2], 10);
  try {
    validateStableDocumentReference({ sourcePath, line, projectRoot });
  } catch (error) {
    if (!(error instanceof DocumentAnchorError)) throw error;
    if (["path_not_normalized", "isolated_path", "not_stable_document"].includes(error.code)) {
      throw new Error(`constraint source escapes approved document roots: ${source}`);
    }
    if (error.code === "outside_project") {
      throw new Error(`constraint source escapes project root: ${source}`);
    }
    if (error.code === "symbolic_link") {
      throw new Error(`constraint source uses a symbolic link: ${sourcePath}`);
    }
    if (error.code === "file_missing") {
      throw new Error(`constraint source file does not exist: ${sourcePath}`);
    }
    if (error.code === "line_exceeds") {
      throw new Error(`constraint source line ${line} exceeds ${sourcePath} line count ${error.details.lineCount}`);
    }
    throw error;
  }
}

export function formatDocumentAnchorErrorZh(error) {
  if (!(error instanceof DocumentAnchorError)) return error.message;
  const { sourcePath, line, lineCount } = error.details;
  if (error.code === "path_required") return "source_path 必须是非空字符串";
  if (error.code === "path_not_normalized") return `source_path 必须是规范化的项目内相对路径：${sourcePath}`;
  if (error.code === "isolated_path") return `拒绝隔离路径：${sourcePath}`;
  if (error.code === "not_stable_document") return `source_path 必须是稳定文档锚点：${sourcePath}`;
  if (error.code === "outside_project") return `source_path 超出项目根目录：${sourcePath}`;
  if (error.code === "symbolic_link") return `source_path 不得引用符号链接：${sourcePath}`;
  if (error.code === "file_missing") return `source_path 文件不存在：${sourcePath}`;
  if (error.code === "line_invalid") return `line 必须是正整数：${line}`;
  if (error.code === "line_exceeds") return `line ${line} 超过 ${sourcePath} 的实际行数 ${lineCount}`;
  return error.message;
}
