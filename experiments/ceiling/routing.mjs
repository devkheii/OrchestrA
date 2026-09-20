import { readFileSync, existsSync } from "node:fs";
import { extractCode, buildProgram } from "./extract.mjs";
import { gradeBatch } from "./grade.mjs";

/**
 * What would routing have bought?
 *
 * Asked of data already on disk, before proposing to build anything. The same
 * three models answered both a code set and a factual set, so the question
 * "does picking the right model per task beat using one model for everything"
 * has an answer here without another run.
 *
 * Three policies, in increasing order of what they would require to exist:
 *
 *   best single    one model for everything - the baseline to beat
 *   per-family     route by task type, which a classifier could actually do
 *   oracle         per-task perfect routing, an upper bound nobody reaches
 */

const MODELS = ["q27-flat", "qf-flat", "llama"];

// --- code: run 3 for llama, run 4 for the two remote ones --------------------
const codeTasks = readFileSync("data/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const codeById = new Map(codeTasks.map((t) => [t.task_id, t]));

function loadAnswers(path) {
  const map = new Map();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    map.set(r.id, r);
  }
  return map;
}

const codeSource = {
  "q27-flat": "results/r4/answers-q27-flat.jsonl",
  "qf-flat": "results/r4/answers-qf-flat.jsonl",
  llama: "results/r3/answers-llama.jsonl",
};

const codeOutcome = new Map();
for (const key of MODELS) {
  const path = codeSource[key];
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const answers = loadAnswers(path);
  const programs = [];
  const fail = new Set();
  for (const t of codeTasks) {
    const a = answers.get(t.task_id);
    if (!a || a.error || a.finish === "length") { fail.add(t.task_id); continue; }
    const code = extractCode(a.answer);
    if (!code) { fail.add(t.task_id); continue; }
    programs.push({ id: t.task_id, program: buildProgram(codeById.get(t.task_id), code) });
  }
  const verdicts = await gradeBatch(programs);
  const m = new Map();
  for (const t of codeTasks) m.set(t.task_id, false);
  for (const v of verdicts) m.set(v.id, v.pass);
  codeOutcome.set(key, m);
  process.stderr.write(`graded code/${key}\n`);
}

// --- factual -----------------------------------------------------------------
const factTasks = readFileSync("factual/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const normalize = (t) =>
  t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ").trim();

const factOutcome = new Map();
for (const key of MODELS) {
  const answers = loadAnswers(`factual/results/answers-${key}.jsonl`);
  const m = new Map();
  for (const t of factTasks) {
    const a = answers.get(t.id);
    const said = a && !a.error ? normalize(a.answer ?? "") : "";
    m.set(t.id, said !== "" && t.aliases.some((x) => normalize(x) === said));
  }
  factOutcome.set(key, m);
}

// --- policies ----------------------------------------------------------------
function score(outcome, ids) {
  const per = Object.fromEntries(
    MODELS.map((k) => [k, ids.filter((id) => outcome.get(k).get(id)).length]),
  );
  const oracle = ids.filter((id) => MODELS.some((k) => outcome.get(k).get(id))).length;
  return { per, oracle, n: ids.length };
}

const code = score(codeOutcome, codeTasks.map((t) => t.task_id));
const fact = score(factOutcome, factTasks.map((t) => t.id));

const pct = (x, n) => `${((x / n) * 100).toFixed(1)}%`;

console.log("\n# What routing would have bought\n");
console.log("| model | code (n=" + code.n + ") | factual (n=" + fact.n + ") |");
console.log("|---|---|---|");
for (const k of MODELS) {
  console.log(`| ${k} | ${code.per[k]}/${code.n} (${pct(code.per[k], code.n)}) | ${fact.per[k]}/${fact.n} (${pct(fact.per[k], fact.n)}) |`);
}

const bestCode = Math.max(...MODELS.map((k) => code.per[k]));
const bestFact = Math.max(...MODELS.map((k) => fact.per[k]));
const bestCodeModel = MODELS.find((k) => code.per[k] === bestCode);
const bestFactModel = MODELS.find((k) => fact.per[k] === bestFact);

// One model for everything: the one with the best combined rate.
const combined = MODELS.map((k) => ({
  key: k,
  rate: (code.per[k] + fact.per[k]) / (code.n + fact.n),
}));
const single = combined.reduce((a, b) => (b.rate > a.rate ? b : a));

const perFamily = (bestCode + bestFact) / (code.n + fact.n);
const oracle = (code.oracle + fact.oracle) / (code.n + fact.n);

console.log("\n| policy | overall accuracy | needs |");
console.log("|---|---|---|");
console.log(`| best single model (${single.key}) | ${(single.rate * 100).toFixed(1)}% | nothing |`);
console.log(`| per-family routing (${bestCodeModel} / ${bestFactModel}) | ${(perFamily * 100).toFixed(1)}% | a task classifier |`);
console.log(`| oracle per-task routing | ${(oracle * 100).toFixed(1)}% | knowing the answer first |`);
console.log(`\nper-family over best single: ${((perFamily - single.rate) * 100).toFixed(1)} points`);
console.log(`oracle over best single:     ${((oracle - single.rate) * 100).toFixed(1)} points`);
