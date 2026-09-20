import { writeFileSync } from "node:fs";

/**
 * The factual task set, fetched and frozen before any model answers.
 *
 * TriviaQA rather than TruthfulQA on purpose. TruthfulQA is adversarially
 * built from misconceptions models share, so it is selected for the exact
 * failure this experiment measures and would overstate it. A non-adversarial
 * set answers the question that generalizes.
 *
 * Graded by matching against the dataset's own alias list — no model in the
 * grading loop. An LLM grader would put a fourth correlated judgment inside a
 * measurement about correlated judgments.
 */

const N = 300;
const SEED = 20260920;
const PAGE = 100;
const PAGES = 6;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const url = (offset, length) =>
  `https://datasets-server.huggingface.co/rows?dataset=mandarjoshi%2Ftrivia_qa` +
  `&config=rc.nocontext&split=validation&offset=${offset}&length=${length}`;

/** Retried, because one refused request should not cost the whole fetch. */
async function getJson(target) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(target);
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw lastError;
}

// The row count comes from the service rather than being assumed, so a dataset
// that grows does not silently change which rows a seed selects.
const head = await getJson(url(0, 1));
const total = head.num_rows_total;

// Pages, not single rows. Three hundred single-row requests is a denial of
// service pointed at a free endpoint, and it was refused as one.
const next = rng(SEED);
const pageStarts = [];
while (pageStarts.length < PAGES) {
  const offset = Math.floor(next() * (total - PAGE));
  if (!pageStarts.some((p) => Math.abs(p - offset) < PAGE)) pageStarts.push(offset);
}

const pool = [];
for (const [i, offset] of pageStarts.entries()) {
  const page = await getJson(url(offset, PAGE));
  for (const entry of page.rows ?? []) {
    const row = entry.row;
    const aliases = row.answer?.normalized_aliases ?? [];
    if (!row.question || aliases.length === 0) continue;
    pool.push({
      id: row.question_id,
      question: row.question,
      answer: row.answer.value,
      aliases,
    });
  }
  process.stderr.write(`\r  page ${i + 1}/${PAGES}, pool ${pool.length}   `);
}
process.stderr.write("\n");

// Shuffled with the same seed, so the selection is reproducible from the
// recorded number rather than from whatever order the service returned.
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(next() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const tasks = pool.slice(0, N);

writeFileSync("factual/tasks.jsonl", tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");

const aliasCounts = tasks.map((t) => t.aliases.length).sort((a, b) => a - b);
console.log(`${tasks.length} tasks from ${total} rows, seed ${SEED}`);
console.log(`aliases per task: median ${aliasCounts[Math.floor(tasks.length / 2)]}, max ${aliasCounts.at(-1)}`);
