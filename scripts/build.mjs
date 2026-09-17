#!/usr/bin/env node
/**
 * Build a runnable `dem` (plan: install on PATH).
 *
 * tsc's `paths` are a compile-time fiction: the emitted JavaScript still says
 * `@dem/engine`, and node resolves that to a package whose "main" is a .ts
 * file it cannot run. So after emitting, rewrite every workspace specifier to
 * the relative path of the emitted file it meant.
 *
 * A bundler would do this too. This is twenty lines and leaves the output
 * readable, which matters for a harness whose claim is that you can audit it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, chmodSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");

const TARGETS = {
  "@dem/protocol": "packages/protocol/src/index.js",
  "@dem/engine": "packages/engine/src/index.js",
  "@dem/adapters": "packages/adapters/src/index.js",
  "@dem/daemon": "apps/daemon/src/index.js",
  "@dem/cli": "apps/cli/src/index.js",
};

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit", shell: process.platform === "win32" });

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".js")) yield path;
  }
}

let rewritten = 0;
for (const file of walk(dist)) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [spec, target] of Object.entries(TARGETS)) {
    let rel = relative(dirname(file), join(dist, target)).split(sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    after = after.replaceAll(`"${spec}"`, `"${rel}"`);
  }
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

const bin = join(dist, "apps/cli/src/bin.js");
chmodSync(bin, 0o755);
console.log(`built ${bin} (${rewritten} files rewired)`);
