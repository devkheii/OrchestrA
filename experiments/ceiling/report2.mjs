import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUN2, SAMPLING } from "./models.mjs";
import { extractCode, buildProgram } from "./extract.mjs";
import { gradeBatch } from "./grade.mjs";

/**
 * Run 2: three models, three pairs, one report.
 *
 * Applies the rule fixed in PREREG-2.md before any of the new models ran,
 * including the validity conditions that run 1 failed without anyone having
 * written them down first.
 */

const tasks = readFileSync("data/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ids = tasks.map((t) => t.task_id);
const byId = new Map(tasks.map((t) => [t.task_id, t]));
const n = tasks.length;

const graded = new Map();

for (const model of RUN2) {
  const path = join("results", `answers-${model.key}.jsonl`);
  if (!existsSync(path)) {
    console.error(`missing ${path} - run: node run.mjs ${model.key}`);
    process.exit(2);
  }

  // Later lines win: a re-run of a failed request is appended after the
  // failure it replaces.
  const answers = new Map();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    answers.set(record.id, record);
  }

  const programs = [];
  const notes = new Map();

  for (const id of ids) {
    const answer = answers.get(id);
    if (!answer) { notes.set(id, "missing"); continue; }
    if (answer.error) { notes.set(id, "error"); continue; }
    if (answer.finish === "length") { notes.set(id, "truncated"); continue; }

    const code = extractCode(answer.answer);
    if (!code) { notes.set(id, "no-code"); continue; }
    programs.push({ id, program: buildProgram(byId.get(id), code) });
  }

  process.stderr.write(`grading ${model.key}: ${programs.length} programs... `);
  const verdicts = programs.length ? await gradeBatch(programs) : [];
  process.stderr.write("done\n");

  const outcome = new Map();
  for (const [id, note] of notes) outcome.set(id, { pass: false, note });
  for (const v of verdicts) outcome.set(v.id, { pass: v.pass, note: v.pass ? "pass" : "fail" });
  graded.set(model.key, outcome);
}

const scoredCount = (key) =>
  [...graded.get(key).values()].filter((o) => o.note === "pass" || o.note === "fail").length;
const passCount = (key) => [...graded.get(key).values()].filter((o) => o.pass).length;
const noteCount = (key, note) =>
  [...graded.get(key).values()].filter((o) => o.note === note).length;

/** PREREG-2 condition 1: a model that did not answer was not measured. */
const UNANSWERED_LIMIT = 5;
const modelValid = (key) => n - scoredCount(key) <= UNANSWERED_LIMIT;

function analysePair(a, b) {
  const A = graded.get(a.key);
  const B = graded.get(b.key);
  const cell = { both: [], onlyA: [], onlyB: [], neither: [] };

  for (const id of ids) {
    const pa = A.get(id).pass;
    const pb = B.get(id).pass;
    if (pa && pb) cell.both.push(id);
    else if (pa) cell.onlyA.push(id);
    else if (pb) cell.onlyB.push(id);
    else cell.neither.push(id);
  }

  const passA = cell.both.length + cell.onlyA.length;
  const passB = cell.both.length + cell.onlyB.length;
  const bestSingle = Math.max(passA, passB);
  const oracle = cell.both.length + cell.onlyA.length + cell.onlyB.length;
  const ceiling = oracle - bestSingle;

  // PREREG-2 condition 2: of the tasks the stronger model got wrong - the only
  // tasks a council can gain on - how many did the other never complete?
  const strong = passA >= passB ? a : b;
  const other = strong === a ? b : a;
  const strongFails = ids.filter((id) => !graded.get(strong.key).get(id).pass);
  const blind = strongFails.filter((id) => {
    const o = graded.get(other.key).get(id);
    return o.note !== "pass" && o.note !== "fail";
  });
  const blindFraction = strongFails.length ? blind.length / strongFails.length : 0;

  const valid = modelValid(a.key) && modelValid(b.key) && blindFraction <= 0.10;

  const verdict = !valid
    ? "INVALID - not measured, not a negative result"
    : ceiling / n <= 0.05
      ? "below threshold"
      : ceiling / n >= 0.10
        ? "CANDIDATE"
        : "inconclusive at this n";

  return { a, b, cell, passA, passB, bestSingle, oracle, ceiling, strong, other,
           strongFails, blind, blindFraction, valid, verdict };
}

const pairs = [];
for (let i = 0; i < RUN2.length; i++)
  for (let j = i + 1; j < RUN2.length; j++)
    pairs.push(analysePair(RUN2[i], RUN2[j]));

const candidates = pairs.filter((p) => p.verdict === "CANDIDATE");

// The cross-pair rule from PREREG-2, applied rather than re-decided.
let decision;
if (candidates.length === 0) {
  decision =
    "**NEGATIVE** - no pair reaches the threshold. Checkpoint B is answered negative " +
    "for local councils in this hardware class. Do not build the v0.2-alpha council.";
} else {
  const best = candidates.reduce((x, y) => (y.ceiling > x.ceiling ? y : x));
  const tied = candidates.filter((p) => Math.abs(p.ceiling - best.ceiling) <= 1);
  const chosen = tied.length > 1 ? tied : [best];
  decision =
    "**PROCEED with " + chosen.map((p) => p.a.key + "+" + p.b.key).join(" or ") + "** - " +
    "headroom exists. That is permission to run the pre-registered efficacy " +
    "experiment, not evidence that Democracy works." +
    (tied.length > 1 ? " Within one task of each other, so the cheaper pair in wall-clock is used." : "");
}

const pct = (k) => ((k / n) * 100).toFixed(1) + "%";

const out = [
  "# Ceiling measurement, run 2 - results",
  "",
  `**Run:** ${new Date().toISOString().slice(0, 10)}  ·  **n = ${n}**  ·  HumanEval+ OriginFmt v0.1.10`,
  `**Sampling:** greedy, temperature ${SAMPLING.temperature}, seed ${SAMPLING.seed}, 1 sample per task`,
  "**Rule:** fixed in [PREREG-2.md](PREREG-2.md) before either new model ran",
  "",
  "## Models",
  "",
  "| model | family | passes | | answered | truncated | no code | error |",
  "|---|---|---|---|---|---|---|---|",
  ...RUN2.map((m) =>
    `| ${m.label} ${m.quant} | ${m.family} | ${passCount(m.key)}/${n} | ${pct(passCount(m.key))} | ` +
    `${scoredCount(m.key)}/${n} | ${noteCount(m.key, "truncated")} | ${noteCount(m.key, "no-code")} | ` +
    `${noteCount(m.key, "error")} |`),
  "",
  "## Pairs",
  "",
  "| pair | both | only A | only B | neither | best single | oracle | **ceiling** | verdict |",
  "|---|---|---|---|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a.key} + ${p.b.key} | ${p.cell.both.length} | ${p.cell.onlyA.length} | ` +
    `${p.cell.onlyB.length} | ${p.cell.neither.length} | ${p.bestSingle} | ${p.oracle} | ` +
    `**${p.ceiling}** (${pct(p.ceiling)}) | ${p.verdict} |`),
  "",
  "## Decision",
  "",
  "> " + decision,
  "",
  "## Validity",
  "",
  "PREREG-2 fixed two conditions in advance, both from the way run 1 failed.",
  "",
  `**1. Every model answers every task** (at most ${UNANSWERED_LIMIT} of ${n} unanswered):`,
  "",
  ...RUN2.map((m) =>
    `- ${m.key}: answered ${scoredCount(m.key)}/${n} - ${modelValid(m.key) ? "ok" : "**fails this condition**"}`),
  "",
  "**2. The blind spot** - of the tasks the stronger model got wrong, how many did the other never complete (limit 10%):",
  "",
  ...pairs.map((p) =>
    `- ${p.a.key} + ${p.b.key}: ${p.blind.length}/${p.strongFails.length} of ${p.strong.key}'s failures ` +
    `were never completed by ${p.other.key} - ${p.blindFraction <= 0.10 ? "ok" : "**fails this condition**"}`),
  "",
  "## Discordant tasks",
  "",
  ...pairs.flatMap((p) => [
    `**${p.a.key} + ${p.b.key}**`,
    "",
    `- only ${p.a.key}: ${p.cell.onlyA.join(", ") || "-"}`,
    `- only ${p.b.key}: ${p.cell.onlyB.join(", ") || "-"}`,
    "",
  ]),
].join("\n");

writeFileSync(join("results", "REPORT-2.md"), out);
console.log(out);
