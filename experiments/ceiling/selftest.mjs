import { readFileSync } from "node:fs";
import { gradeBatch } from "./grade.mjs";

/**
 * Does the grader agree that the reference answer is right?
 *
 * The load-bearing check of this whole experiment. A grader that fails good
 * code would report both models as wrong everywhere and make the ceiling look
 * like zero — the exact conclusion that stops further work. It has to be shown
 * correct before any model output is judged by it.
 */
const tasks = readFileSync("data/HumanEvalPlus-OriginFmt.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const programs = tasks.map((t) => ({
  id: t.task_id,
  program: `${t.prompt}${t.canonical_solution}\n\n${t.test}\n\ncheck(${t.entry_point})\n`,
}));

const started = Date.now();
const verdicts = await gradeBatch(programs);
const failed = verdicts.filter((v) => !v.pass);

console.log(`${verdicts.length - failed.length}/${verdicts.length} reference solutions pass`);
console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const f of failed.slice(0, 5)) console.log(`  ${f.id} (${f.code}) ${(f.stderr ?? "").slice(-200)}`);
