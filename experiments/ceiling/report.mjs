import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MODELS, SAMPLING } from "./models.mjs";
import { extractCode, buildProgram } from "./extract.mjs";
import { gradeBatch } from "./grade.mjs";

/**
 * Grade what the models answered, count the four cells, apply the rule that
 * was fixed in README.md before any of them ran.
 */

const tasks = readFileSync("data/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map(tasks.map((t) => [t.task_id, t]));

const graded = new Map();

for (const model of MODELS) {
  const path = join("results", `answers-${model.key}.jsonl`);
  if (!existsSync(path)) {
    console.error(`missing ${path} — run \`node run.mjs ${model.key}\` first`);
    process.exit(2);
  }

  const answers = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const programs = [];
  const notes = new Map();

  for (const answer of answers) {
    const task = byId.get(answer.id);
    if (!task) continue;

    if (answer.error) { notes.set(answer.id, "error"); continue; }
    if (answer.finish === "length") { notes.set(answer.id, "truncated"); continue; }

    const code = extractCode(answer.answer);
    if (!code) { notes.set(answer.id, "no-code"); continue; }

    programs.push({ id: answer.id, program: buildProgram(task, code) });
  }

  process.stderr.write(`grading ${model.key}: ${programs.length} programs... `);
  const verdicts = programs.length ? await gradeBatch(programs) : [];
  process.stderr.write("done\n");

  const outcome = new Map();
  for (const [id, note] of notes) outcome.set(id, { pass: false, note });
  for (const v of verdicts) outcome.set(v.id, { pass: v.pass, note: v.pass ? "pass" : "fail" });
  graded.set(model.key, { outcome, answers: answers.length });
}

const [a, b] = MODELS;
const A = graded.get(a.key).outcome;
const B = graded.get(b.key).outcome;

const scored = tasks.filter((t) => A.has(t.task_id) && B.has(t.task_id));
const cell = { both: [], onlyA: [], onlyB: [], neither: [] };

for (const task of scored) {
  const pa = A.get(task.task_id).pass;
  const pb = B.get(task.task_id).pass;
  if (pa && pb) cell.both.push(task.task_id);
  else if (pa) cell.onlyA.push(task.task_id);
  else if (pb) cell.onlyB.push(task.task_id);
  else cell.neither.push(task.task_id);
}

const n = scored.length;
const passA = cell.both.length + cell.onlyA.length;
const passB = cell.both.length + cell.onlyB.length;
const bestSingle = Math.max(passA, passB);
const oracle = cell.both.length + cell.onlyA.length + cell.onlyB.length;
const ceiling = oracle - bestSingle;

const pct = (k) => `${((k / n) * 100).toFixed(1)}%`;
const noteCount = (key, note) =>
  [...graded.get(key).outcome.values()].filter((o) => o.note === note).length;

// The rule from README.md, applied rather than re-decided. The thresholds are
// expressed as fractions of n so a run over the full 163 uses the same rule.
const decision =
  ceiling / n <= 0.05
    ? "NEGATIVE — premise not supported for this pair; do not build the council"
    : ceiling / n >= 0.10
      ? "PROCEED — headroom exists; run the pre-registered experiment"
      : "INCONCLUSIVE — extend to all 163 tasks before deciding";

// Whether the rule's precondition held: that both arms were actually measured.
//
// A model that never emitted an answer was not wrong, it was not asked
// properly. Counting that as a failure is what the pre-registration says to do
// with a truncation, and that is still what the primary result above does —
// the rule is not edited after seeing a number. But a rule applied to an arm
// that could not answer half its tasks is reporting the budget, so the
// condition is computed and stated next to the decision rather than left for a
// reader to notice.
const completed = (key) =>
  [...graded.get(key).outcome.values()].filter((o) => o.note === "pass" || o.note === "fail").length;

const passGiven = (key) => {
  const vals = [...graded.get(key).outcome.values()];
  const done = vals.filter((o) => o.note === "pass" || o.note === "fail");
  return done.length ? vals.filter((o) => o.pass).length / done.length : 0;
};

// The blind spot that matters: tasks the stronger model failed and the other
// one never finished. That is exactly the cell the ceiling is made of.
const strongerKey = passA >= passB ? a.key : b.key;
const otherKey = strongerKey === a.key ? b.key : a.key;
const strongerFails = tasks
  .map((t) => t.task_id)
  .filter((id) => graded.get(strongerKey).outcome.get(id) && !graded.get(strongerKey).outcome.get(id).pass);
const unattempted = strongerFails.filter((id) => {
  const o = graded.get(otherKey).outcome.get(id);
  return o && o.note !== "pass" && o.note !== "fail";
});

const valid = MODELS.every((m) => completed(m.key) === n);

const lines = [
  `# Ceiling measurement — results`,
  ``,
  `**Run:** ${new Date().toISOString().slice(0, 10)}  ·  **n = ${n}**  ·  HumanEval+ OriginFmt v0.1.10`,
  `**Sampling:** greedy, temperature ${SAMPLING.temperature}, seed ${SAMPLING.seed}, 1 sample per task`,
  `**Rule:** fixed in [README.md](README.md) before any model ran`,
  ``,
  `| | passes | |`,
  `|---|---|---|`,
  `| ${a.label} ${a.quant} | ${passA}/${n} | ${pct(passA)} |`,
  `| ${b.label} ${b.quant} | ${passB}/${n} | ${pct(passB)} |`,
  ``,
  `## The four cells`,
  ``,
  `| | ${b.key} pass | ${b.key} fail |`,
  `|---|---|---|`,
  `| **${a.key} pass** | ${cell.both.length} | ${cell.onlyA.length} |`,
  `| **${a.key} fail** | ${cell.onlyB.length} | ${cell.neither.length} |`,
  ``,
  `- best single model: **${bestSingle}/${n}** (${pct(bestSingle)})`,
  `- perfect selector (oracle): **${oracle}/${n}** (${pct(oracle)})`,
  `- **ceiling = ${ceiling}/${n} (${pct(ceiling)})**`,
  `- neither model solves: ${cell.neither.length}/${n} — beyond any council of this pair`,
  ``,
  `## Decision`,
  ``,
  `> **${decision}**`,
  ``,
  `## Is this measurement valid?`,
  ``,
  valid
    ? `Both models answered all ${n} tasks. The rule above applies as written.`
    : [
        `**No.** The rule above is reported as written — it is not edited after seeing a`,
        `result — but its precondition did not hold.`,
        ``,
        ...MODELS.map((m) =>
          `- **${m.key}**: answered ${completed(m.key)}/${n}; of those it answered, it passed ` +
          `${(passGiven(m.key) * 100).toFixed(0)}%`),
        ``,
        `Worse than the count: of the ${strongerFails.length} tasks **${strongerKey}** got wrong — the only`,
        `tasks where a council could gain anything — **${otherKey}** never finished ${unattempted.length}.`,
        `The ceiling is made of exactly that cell, so it is measured on ` +
          `${strongerFails.length - unattempted.length} of the ${strongerFails.length} tasks that could contribute to it.`,
        ``,
        `A truncated answer is scored as a failure because that is what was fixed in`,
        `advance, and that is the right call for a model that cannot deliver inside a`,
        `budget. It is the wrong call for deciding whether a council helps, because the`,
        `model did not give a wrong answer — it gave no answer. Extending to 163 tasks`,
        `would reproduce this blindness at 2.7x the cost, not resolve it.`,
      ].join("\n"),
  ``,
  `## Answer quality notes`,
  ``,
  `| | truncated | no code | request error |`,
  `|---|---|---|---|`,
  ...MODELS.map((m) =>
    `| ${m.key} | ${noteCount(m.key, "truncated")} | ${noteCount(m.key, "no-code")} | ${noteCount(m.key, "error")} |`),
  ``,
  `## Discordant tasks`,
  ``,
  `Only ${a.key}: ${cell.onlyA.join(", ") || "—"}`,
  ``,
  `Only ${b.key}: ${cell.onlyB.join(", ") || "—"}`,
  ``,
];

const report = lines.join("\n");
writeFileSync(join("results", "REPORT.md"), report);
console.log(report);
