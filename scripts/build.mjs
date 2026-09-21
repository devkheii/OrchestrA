#!/usr/bin/env node
/**
 * Build a runnable `dem`.
 *
 * Bundled rather than emitted file-by-file. The earlier build wrote the
 * monorepo's shape into `dist/` and rewrote the `@dem/*` specifiers, which
 * worked only because every third-party dependency it needed happened to be
 * declared at the root: `dist/apps/cli/src/...` resolves upward to
 * `<repo>/node_modules`, and pnpm puts a package's own dependencies in that
 * package's directory. The first dependency added to `apps/cli` alone — ink —
 * broke the installed command while every test passed, because the tests run
 * from source where resolution is correct.
 *
 * A bundle has no resolution to get wrong. It also makes `dem` a single file,
 * which is what a command on someone's PATH should be.
 *
 * Native modules stay external: they load `.node` binaries that cannot be
 * bundled, and they are declared at the root, which is where the bundle
 * resolves them from.
 */
import { build } from "esbuild";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "dem.mjs");

const EXTERNAL = [
  // Load .node binaries.
  "better-sqlite3",
  "node-pty",
  // Optional at runtime and large; required only by the Anthropic provider.
  "@anthropic-ai/sdk",
];

const result = await build({
  entryPoints: [join(root, "apps", "cli", "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: EXTERNAL,
  // Workspace packages are source, not built artifacts, so the bundler is
  // told where the names point rather than being left to npm resolution.
  alias: {
    "@dem/protocol": join(root, "packages", "protocol", "src", "index.ts"),
    "@dem/engine": join(root, "packages", "engine", "src", "index.ts"),
    "@dem/adapters": join(root, "packages", "adapters", "src", "index.ts"),
    "@dem/daemon": join(root, "apps", "daemon", "src", "index.ts"),
    "@dem/cli": join(root, "apps", "cli", "src", "index.ts"),
    // Ink imports this at load and uses it only behind a development flag a
    // released command never sets. External left a real import that failed at
    // startup; bundling it would put a debugger in the binary.
    "react-devtools-core": join(root, "scripts", "shims", "empty.mjs"),
  },
  jsx: "automatic",
  // Readable output. A harness whose claim is that you can audit it should not
  // ship a minified blob, and the size difference is not worth the opacity.
  minify: false,
  sourcemap: false,
  banner: {
    js: [
      // No shebang here: esbuild preserves the entry point's own, and two
      // of them makes the second line a syntax error.
      // esbuild's ESM output has no `require`, which some transitive CommonJS
      // still reaches for.
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

if (result.errors.length) process.exit(1);

await chmod(outfile, 0o755);

// A package.json beside the bundle, so node reads it as ESM regardless of what
// the directory above says.
await mkdir(dirname(outfile), { recursive: true });
await writeFile(join(root, "dist", "package.json"), JSON.stringify({ type: "module" }, null, 2));

console.log(`built ${outfile}`);
