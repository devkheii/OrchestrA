#!/usr/bin/env node
/**
 * Enforces SPEC section 32: every invariant maps to a test ID, and every test
 * ID used anywhere is one the SPEC actually declares.
 *
 * This ran as a manual cross-check while the documents were being written and
 * drifted within one revision, which is the argument for automating it.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = /\b(?:SEC|DEC|RUN|ORCH)-\d{3}\b/g;

const read = (p) => readFile(join(root, p), "utf8");
const idsIn = (text) => new Set(text.match(ID) ?? []);

const problems = [];
const fail = (msg) => problems.push(msg);

/**
 * The design documents are kept out of the repository, so a clone may not have
 * them. Skip rather than fail: this check is a guard for whoever holds the
 * contract, not a build dependency for whoever only has the code.
 */
let spec;
let matrix;
try {
  spec = await read("docs/SPEC.md");
  matrix = await read("docs/INVARIANT_TEST_MATRIX.md");
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  console.log(
    "matrix check skipped: docs/SPEC.md not present in this checkout (design docs are kept local)",
  );
  process.exit(0);
}

// Test IDs the SPEC declares, taken from section 31 only.
const section31 = spec.split("\n## 31. Required tests")[1]?.split("\n## 32.")[0] ?? "";
if (!section31) fail("docs/SPEC.md: section 31 (Required tests) not found");
const declared = idsIn(section31);

// 1. Every invariant in SPEC section 2 has a matrix row.
const section2 = spec.split("\n## 2. Non-negotiable invariants")[1]?.split("\n---")[0] ?? "";
const invariantCount = (section2.match(/^\d+\. /gm) ?? []).length;
const rows = [...matrix.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
for (let i = 1; i <= invariantCount; i++) {
  if (!rows.includes(i)) fail(`invariant ${i} has no row in INVARIANT_TEST_MATRIX.md`);
}
const dupes = rows.filter((n, i) => rows.indexOf(n) !== i);
if (dupes.length) fail(`duplicate matrix rows for invariant(s): ${[...new Set(dupes)].join(", ")}`);

// 2. Every ID used in the matrix is declared in the SPEC.
for (const id of idsIn(matrix)) {
  if (!declared.has(id)) fail(`INVARIANT_TEST_MATRIX.md references undeclared test ${id}`);
}

// 3. Every ID referenced in source or tests is declared in the SPEC.
// Written as a plain walk rather than fs.promises.glob, which needs Node 22+.
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

for (const dir of ["tests", "packages", "apps"]) {
  for await (const file of walk(join(root, dir))) {
    const text = await readFile(file, "utf8");
    for (const id of idsIn(text)) {
      if (!declared.has(id)) {
        fail(`${relative(root, file)} references undeclared test ${id}`);
      }
    }
  }
}

// 4. Every row carries a status, per SPEC section 32: never a blank.
for (const line of matrix.split("\n")) {
  const m = /^\| (\d+) \|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
  if (!m) continue;
  if (!m[2].trim()) fail(`invariant ${m[1]}: no test IDs`);
  if (!m[4].trim()) fail(`invariant ${m[1]}: blank status (use "deferred (<release>)")`);
}

if (problems.length) {
  console.error("invariant/test matrix check failed:\n");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(
  `matrix ok: ${invariantCount} invariants, ${rows.length} rows, ${declared.size} declared test IDs`,
);
