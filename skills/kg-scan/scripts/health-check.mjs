#!/usr/bin/env node

// Public health-check entrypoint for the deterministic staleness scanner.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as checkStaleness } from "./check-staleness.mjs";

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) checkStaleness(process.argv.slice(2));
