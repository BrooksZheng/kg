// Install kg into a host repository. Idempotent: re-running never duplicates
// the anchor block, never overwrites an existing config, and refreshes
// discovery wiring in place.
//
// Usage:
//   node skills/kg-init/scripts/install.mjs [host-root] [--copy] \
//     [--threshold N] [--budget N]
//
//   host-root    defaults to $KG_ROOT or cwd
//   --copy       copy skills into .agents/skills/ instead of symlinking
//                (use when the host cannot reference the plugin checkout,
//                e.g. vendoring kg into a repo that ships without it)
//   --threshold  observation_threshold for a fresh config (default 5)
//   --budget     agents_block_budget_lines for a fresh config (default 30)
//
// What it does:
//   1. .kg/ tree: config.yaml (fresh installs only), observations/,
//      observations/processed/, queue/, reports/ — plus knowledge/.
//   2. AGENTS.md managed block: plants <!-- kg:begin/end --> anchors (creates
//      the file if absent, appends if present — content outside the anchors
//      is never touched) and renders the resident block.
//   3. Platform ignore (best-effort secondary defense): adds `.kg/` to
//      .cursorignore. The PRIMARY defense is the hard rule inside the block.
//   4. Platform discovery: Cursor finds skills under .agents/skills/ —
//      symlink (default) or copy each kg skill there. Codex needs no wiring:
//      it reaches the skills through the AGENTS.md block pointers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kyaml, host, agentsBlock } from "./_lib.mjs";

const args = process.argv.slice(2);
const copyMode = args.includes("--copy");
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number.parseInt(args[i + 1], 10);
  if (!Number.isInteger(v) || v <= 0) host.fail(`${name} needs a positive integer`);
  return v;
}
const threshold = flagValue("--threshold", host.CONFIG_DEFAULTS.observation_threshold);
const budget = flagValue("--budget", host.CONFIG_DEFAULTS.agents_block_budget_lines);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--threshold" && args[i - 1] !== "--budget");
const hostRoot = path.resolve(positional[0] ?? process.env.KG_ROOT ?? process.cwd());

if (!fs.existsSync(hostRoot)) host.fail(`host root does not exist: ${hostRoot}`);

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPTS_DIR, "..", "..", "..");
const SKILL_NAMES = ["kg-init", "kg-observe", "kg-compile"];
const paths = host.kgPaths(hostRoot);
const log = (msg) => console.log(`kg: ${msg}`);

// --- 1. directory tree -------------------------------------------------------

for (const dir of [paths.kg, paths.observations, paths.processed, paths.queue, paths.reports, paths.knowledge]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`created ${path.relative(hostRoot, dir)}/`);
  }
}

if (fs.existsSync(paths.config)) {
  log("config.yaml exists — left untouched");
} else {
  const config = {
    observation_threshold: threshold,
    agents_block_budget_lines: budget,
    skills_path: ".agents/skills",
  };
  fs.writeFileSync(
    paths.config,
    "# kg pipeline configuration (KYAML). Edit freely; kg-init never overwrites.\n" + kyaml.stringify(config),
  );
  log(`wrote .kg/config.yaml (threshold ${threshold}, AGENTS budget ${budget})`);
}

// --- 2. AGENTS.md anchors + render --------------------------------------------

const { BEGIN, END } = agentsBlock;
let agentsText = fs.existsSync(paths.agentsMd) ? fs.readFileSync(paths.agentsMd, "utf8") : null;
if (agentsText === null) {
  fs.writeFileSync(paths.agentsMd, `${BEGIN}\n${END}\n`);
  log("created AGENTS.md with kg anchors");
} else if (agentsText.includes(BEGIN) && agentsText.includes(END)) {
  log("AGENTS.md anchors already present");
} else if (agentsText.includes(BEGIN) || agentsText.includes(END)) {
  host.fail("AGENTS.md has one anchor but not the other — repair it by hand, then re-run");
} else {
  const sep = agentsText.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(paths.agentsMd, `${agentsText}${sep}${BEGIN}\n${END}\n`);
  log("appended kg anchors to existing AGENTS.md (existing content untouched)");
}
agentsBlock.applyBlock(hostRoot);

// --- 3. platform ignore (secondary defense) ------------------------------------

const cursorignore = path.join(hostRoot, ".cursorignore");
const ignoreLine = ".kg/";
const existing = fs.existsSync(cursorignore) ? fs.readFileSync(cursorignore, "utf8") : "";
if (existing.split(/\r?\n/).some((l) => l.trim() === ignoreLine)) {
  log(".cursorignore already covers .kg/");
} else {
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(
    cursorignore,
    existing + sep + "# kg: keep uncompiled pipeline state out of agent context (secondary defense;\n# the primary defense is the hard rule in the AGENTS.md kg block)\n.kg/\n",
  );
  log("added .kg/ to .cursorignore (best-effort secondary defense)");
}

// --- 4. platform discovery wiring -----------------------------------------------

const agentsSkillsDir = path.join(hostRoot, ".agents", "skills");
fs.mkdirSync(agentsSkillsDir, { recursive: true });

// Canonical path identity: realpath when the path exists (so symlink aliases
// of the same directory compare equal), lexical resolve as the fallback for
// not-yet-existing destinations.
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function copyDir(src, dest) {
  // Never let a refresh destroy its own source (e.g. installer re-run from
  // inside a vendored host, where PLUGIN_ROOT resolves into .agents/, or a
  // src/dest reached through a symlink alias).
  if (canonical(src) === canonical(dest)) {
    host.fail(`refusing to copy a directory onto itself: ${src}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

for (const name of SKILL_NAMES) {
  const src = path.join(PLUGIN_ROOT, "skills", name);
  const dest = path.join(agentsSkillsDir, name);
  if (!fs.existsSync(src)) host.fail(`plugin skill missing: ${src}`);
  if (canonical(src) === canonical(dest)) {
    // Re-run from inside a vendored install: the "plugin" IS the host's
    // .agents/skills tree. Nothing to wire; deleting would self-destruct.
    log(`vendored install already in place for ${name} — skipped`);
    continue;
  }
  if (copyMode) {
    copyDir(src, dest);
    // Make the copied skill self-contained: embed shared lib + protocol where
    // the _lib.mjs resolver's `./lib` fallback finds them (scripts/lib/ ->
    // ../../protocol resolves to <skill>/protocol). In the plugin checkout the
    // root copies are the source of truth and overlay whatever the skill dir
    // carried; when installing FROM an already-vendored skill (no root
    // scripts/lib/ next to PLUGIN_ROOT), the recursive copy above already
    // brought the embedded copies along — just verify they arrived.
    for (const [rootRel, destRel] of [
      [["scripts", "lib"], ["scripts", "lib"]],
      [["protocol"], ["protocol"]],
    ]) {
      const rootSrc = path.join(PLUGIN_ROOT, ...rootRel);
      const embedded = path.join(dest, ...destRel);
      if (fs.existsSync(rootSrc)) copyDir(rootSrc, embedded);
      else if (!fs.existsSync(embedded)) host.fail(`cannot make ${name} self-contained: neither ${rootSrc} nor an embedded ${destRel.join("/")} copy exists`);
    }
    log(`copied skill ${name} -> .agents/skills/${name} (self-contained)`);
  } else {
    let current = null;
    try {
      current = fs.readlinkSync(dest);
    } catch {
      if (fs.existsSync(dest)) host.fail(`.agents/skills/${name} exists and is not a symlink — remove it or use --copy`);
    }
    const target = path.relative(agentsSkillsDir, src);
    if (current === target) {
      log(`symlink .agents/skills/${name} already correct`);
    } else {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.symlinkSync(target, dest);
      log(`symlinked .agents/skills/${name} -> ${target}`);
    }
  }
}

// --- 5. Claude Code wiring (only when the host shows Claude markers) ------------
// Claude Code discovers skills under .claude/skills/ and reads CLAUDE.md, not
// AGENTS.md. Wire both: symlink each skill from .claude/skills/ to the
// canonical .agents/skills/ copy, and bridge the managed block via the
// officially recommended `@AGENTS.md` import in CLAUDE.md.

const claudeDir = path.join(hostRoot, ".claude");
const claudeMd = path.join(hostRoot, "CLAUDE.md");
if (fs.existsSync(claudeDir) || fs.existsSync(claudeMd)) {
  const claudeSkillsDir = path.join(claudeDir, "skills");
  fs.mkdirSync(claudeSkillsDir, { recursive: true });
  for (const name of SKILL_NAMES) {
    const canonicalSkill = path.join(agentsSkillsDir, name);
    const dest = path.join(claudeSkillsDir, name);
    if (fs.existsSync(dest)) {
      // Anything already resolving to the canonical copy (e.g. a symlink
      // planted by `npx skills add`) counts as wired, whatever its link text.
      if (canonical(dest) === canonical(canonicalSkill)) {
        log(`.claude/skills/${name} already wired`);
        continue;
      }
      host.fail(`.claude/skills/${name} exists but does not resolve to .agents/skills/${name} — remove it, then re-run`);
    }
    const target = path.relative(claudeSkillsDir, canonicalSkill);
    fs.symlinkSync(target, dest);
    log(`symlinked .claude/skills/${name} -> ${target}`);
  }

  const claudeText = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf8") : null;
  if (claudeText === null) {
    fs.writeFileSync(claudeMd, "@AGENTS.md\n");
    log("created CLAUDE.md importing AGENTS.md (Claude Code does not read AGENTS.md natively)");
  } else if (claudeText.includes("AGENTS.md")) {
    log("CLAUDE.md already references AGENTS.md");
  } else {
    const sep = claudeText.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(claudeMd, `${claudeText}${sep}\n@AGENTS.md\n`);
    log("appended @AGENTS.md import to CLAUDE.md (existing content untouched)");
  }
}

log(`install complete at ${hostRoot}`);
log("next: work normally; record observations via kg-observe; compile when the threshold reminder fires.");
