import { readFileSync, writeFileSync } from "node:fs";

/**
 * The pilot task set, chosen before any model has answered anything.
 *
 * Seeded and recorded so the selection is reproducible and cannot be quietly
 * re-rolled after seeing a result. Written as its own file so the set the
 * experiment ran on is a committed artifact, not an argument to a script.
 */

const N = 60;
const SEED = 20260918;

// HumanEval/32 is excluded on a property of the task, not of any answer: the
// OriginFmt conversion's test calls candidate(*inp) on a function that returns
// a float, so the reference solution itself cannot pass. Grading anything
// against it measures the fixture.
const BROKEN = new Set(["HumanEval/32"]);

const all = readFileSync("data/HumanEvalPlus-OriginFmt.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((t) => !BROKEN.has(t.task_id));

// mulberry32 — a small deterministic PRNG, so "seeded" is a fact anyone can
// re-derive rather than a claim about Math.random.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const next = rng(SEED);
const pool = [...all];
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(next() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}

const picked = pool.slice(0, N).sort((a, b) =>
  Number(a.task_id.split("/")[1]) - Number(b.task_id.split("/")[1]));

writeFileSync("data/tasks.jsonl", picked.map((t) => JSON.stringify(t)).join("\n") + "\n");
console.log(`selected ${picked.length} of ${all.length} (seed ${SEED}, ${BROKEN.size} excluded)`);
console.log(picked.slice(0, 6).map((t) => t.task_id).join(", "), "...");
