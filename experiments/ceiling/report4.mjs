import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUN4, SAMPLING } from "./models.mjs";
import { extractCode, buildProgram } from "./extract.mjs";
import { gradeBatch } from "./grade.mjs";

/**
 * Run 4: four models, six pairs, and the correlation question as the primary
 * outcome rather than an afterthought.
 *
 * Applies PREREG-4.md, which was fixed before any model answered a task under
 * these settings — including the interpretation of phi, so that what may be
 * claimed about "it was just those two models" was decided in advance.
 */

const DIR = process.env["DEM_RESULTS_DIR"] ?? "results/r4";

const tasks = readFileSync("data/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ids = tasks.map((t) => t.task_id);
const byId = new Map(tasks.map((t) => [t.task_id, t]));
const n = tasks.length;

const graded = new Map();
const latency = new Map();

for (const model of RUN4) {
  const path = join(DIR, `answers-${model.key}.jsonl`);
  if (!existsSync(path)) {
    console.error(`missing ${path} - run: DEM_RESULTS_DIR=${DIR} node run.mjs run3`);
    process.exit(2);
  }

  const answers = new Map();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    answers.set(record.id, record);
  }
  latency.set(model.key, [...answers.values()].reduce((s, r) => s + (r.ms ?? 0), 0));

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

const scored = (key) =>
  [...graded.get(key).values()].filter((o) => o.note === "pass" || o.note === "fail").length;
const passes = (key) => [...graded.get(key).values()].filter((o) => o.pass).length;
const noteCount = (key, note) =>
  [...graded.get(key).values()].filter((o) => o.note === note).length;

const UNANSWERED_LIMIT = 5;
const modelValid = (key) => n - scored(key) <= UNANSWERED_LIMIT;


/**
 * A pair isolates style when both sides are the same weights differing only in
 * whether they deliberate. PREREG-4 decides on these and only these; the other
 * four vary style and model together and cannot support a claim about style,
 * whatever they show.
 */
function isolatesStyle(p) {
  return p.a.remoteModel === p.b.remoteModel;
}

function analyse(a, b) {
  const cell = { both: [], onlyA: [], onlyB: [], neither: [] };
  for (const id of ids) {
    const pa = graded.get(a.key).get(id).pass;
    const pb = graded.get(b.key).get(id).pass;
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

  // Failure correlation. Both-fail against what independent failure would give,
  // and the ceiling independence would have produced — the quantity that turns
  // "these models are weak" into "these models are redundant".
  const failA = (n - passA) / n;
  const failB = (n - passB) / n;
  const expNeither = failA * failB * n;
  const expCeiling = Math.min((1 - failA) * failB * n, failA * (1 - failB) * n);

  const num = cell.neither.length * cell.both.length - cell.onlyA.length * cell.onlyB.length;
  const den = Math.sqrt(
    (cell.neither.length + cell.onlyA.length) * (cell.neither.length + cell.onlyB.length) *
    (cell.both.length + cell.onlyA.length) * (cell.both.length + cell.onlyB.length),
  );
  const phi = den === 0 ? 0 : num / den;
  // Fisher z interval. Crude for a phi coefficient, and labelled as such:
  // at n = 60 this is a width, not an estimate.
  const z = 0.5 * Math.log((1 + phi) / (1 - phi));
  const se = 1 / Math.sqrt(n - 3);
  const band = [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];

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
    ? "INVALID"
    : ceiling / n <= 0.05 ? "below threshold"
    : ceiling / n >= 0.10 ? "CANDIDATE"
    : "inconclusive";

  return { a, b, cell, passA, passB, bestSingle, oracle, ceiling, expNeither, expCeiling,
           phi, band, strong, other, strongFails, blind, blindFraction, valid, verdict };
}

const pairs = [];
for (let i = 0; i < RUN4.length; i++)
  for (let j = i + 1; j < RUN4.length; j++)
    pairs.push(analyse(RUN4[i], RUN4[j]));

// Only a measured pair can be a candidate. llama+gemma reaches a ceiling of 6
// on paper and is excluded here, which is the entire purpose of fixing the
// validity conditions before seeing a number.
const candidates = pairs.filter((p) => p.verdict === "CANDIDATE");

let decision;
if (candidates.length === 0) {
  decision = "**NEGATIVE** - no pair reaches the threshold. Checkpoint B stays answered negative " +
    "for local councils in this hardware class.";
} else {
  const best = candidates.reduce((x, y) => (y.ceiling > x.ceiling ? y : x));
  const tied = candidates.filter((p) => Math.abs(p.ceiling - best.ceiling) <= 1);
  decision = "**PROCEED with " + (tied.length > 1 ? tied : [best]).map((p) => p.a.key + "+" + p.b.key).join(" or ") +
    "** - headroom exists. Permission to run the pre-registered efficacy experiment, " +
    "not evidence that Democracy works.";
}

// PREREG-4's interpretation rule, applied rather than re-decided.
const valid = pairs.filter((p) => p.valid);
const styled = valid.filter(isolatesStyle);
const confounded = pairs.filter((p) => !isolatesStyle(p));

let claim;
if (styled.length < 2) {
  claim =
    `**Nothing may be claimed about answering style.** The rule decides on the two ` +
    `style-isolated pairs and ${styled.length} of them ${styled.length === 1 ? "is" : "are"} valid. ` +
    `The four confounded pairs vary style and model together and cannot stand in for them.`;
} else if (styled.every((p) => p.phi < 0.30)) {
  claim =
    `**Answering style decorrelates failure.** Holding weights, lineage, size and training ` +
    `data exactly equal and varying only whether the model deliberates, phi falls to ` +
    `${styled.map((p) => p.phi.toFixed(2)).join(" and ")} — against 0.47-0.58 for every pair of ` +
    `distinct one-shot models measured in runs 2 and 3. A council should pair *modes*, not only ` +
    `models, and that is a design conclusion this project can act on.`;
} else if (styled.every((p) => p.phi >= 0.45)) {
  claim =
    `**Answering style does not decorrelate failure.** With everything else held equal and only ` +
    `the mode varying, phi stays at ${styled.map((p) => p.phi.toFixed(2)).join(" and ")}. The ` +
    `correlation is a property of the model rather than of how it is asked, which weakens the ` +
    `Democracy premise further than runs 2 and 3 did: pairing modes will not rescue a council, ` +
    `and neither, by the same argument, will pairing models that share a lineage.`;
} else {
  claim =
    `**Inconclusive.** The style-isolated pairs give phi ` +
    `${styled.map((p) => `${p.a.key}+${p.b.key} ${p.phi.toFixed(2)}`).join(", ")}, which falls ` +
    `between the thresholds fixed in PREREG-4 or disagrees across the two. Reported; nothing claimed.`;
}

const pct = (k) => ((k / n) * 100).toFixed(1) + "%";
const mins = (k) => (latency.get(k) / 60000).toFixed(0);

const out = [
  "# Ceiling measurement, run 4 - results",
  "",
  `**Run:** ${new Date().toISOString().slice(0, 10)}  ·  **n = ${n}**  ·  HumanEval+ OriginFmt v0.1.10`,
  `**Sampling:** greedy, temperature ${SAMPLING.temperature}, seed ${SAMPLING.seed}, 1 sample per task`,
  "**Server:** `-ngl 999 -fa on -ctk q8_0 -ctv q8_0`, identical for every model",
  "**Rule:** fixed in [PREREG-4.md](PREREG-4.md) before any model answered under these settings",
  "",
  "## Models",
  "",
  "| model | family | passes | | answered | truncated | no code | error | budget | wall clock |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...RUN4.map((m) =>
    `| ${m.label} ${m.quant} | ${m.family} | ${passes(m.key)}/${n} | ${pct(passes(m.key))} | ` +
    `${scored(m.key)}/${n} | ${noteCount(m.key, "truncated")} | ${noteCount(m.key, "no-code")} | ` +
    `${noteCount(m.key, "error")} | ${m.maxTokens} | ${mins(m.key)} min |`),
  "",
  "## Pairs",
  "",
  "| pair | isolates style | both | only A | only B | neither | best | oracle | **ceiling** | verdict |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a.key} + ${p.b.key} | ${isolatesStyle(p) ? "**yes**" : "no"} | ${p.cell.both.length} | ` +
    `${p.cell.onlyA.length} | ${p.cell.onlyB.length} | ${p.cell.neither.length} | ${p.bestSingle} | ` +
    `${p.oracle} | **${p.ceiling}** (${pct(p.ceiling)}) | ${p.verdict} |`),
  "",
  `The ${confounded.length} pairs marked "no" differ in model as well as in mode. They are reported for`,
  "comparison and, by PREREG-4, may not support a claim about answering style.",
  "",
  "## Failure correlation",
  "",
  "The primary question of this run: do these models fail on the same tasks more than chance,",
  "and would independence have changed the verdict?",
  "",
  "| pair | both fail | expected if independent | ratio | **phi** [95%] | ceiling | ceiling if independent |",
  "|---|---|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a.key} + ${p.b.key} | ${p.cell.neither.length} | ${p.expNeither.toFixed(1)} | ` +
    `${(p.cell.neither.length / (p.expNeither || 1)).toFixed(2)}x | **${p.phi.toFixed(2)}** ` +
    `[${p.band[0].toFixed(2)}, ${p.band[1].toFixed(2)}] | ${p.ceiling} | ${p.expCeiling.toFixed(1)} |`),
  "",
  "At n = 60 phi is a width, not an estimate. PREREG-4 set the thresholds far apart for that reason.",
  "",
  "## Decision",
  "",
  "> " + decision,
  "",
  "## What may be claimed",
  "",
  "> " + claim,
  "",
  "## Validity",
  "",
  `**1. Every model answers every task** (at most ${UNANSWERED_LIMIT} of ${n} unanswered):`,
  "",
  ...RUN4.map((m) => `- ${m.key}: answered ${scored(m.key)}/${n} - ${modelValid(m.key) ? "ok" : "**fails**"}`),
  "",
  "**2. The blind spot** - of the tasks the stronger model got wrong, how many did the other never complete (limit 10%):",
  "",
  ...pairs.map((p) =>
    `- ${p.a.key} + ${p.b.key}: ${p.blind.length}/${p.strongFails.length} of ${p.strong.key}'s failures ` +
    `were never completed by ${p.other.key} - ${p.blindFraction <= 0.10 ? "ok" : "**fails**"}`),
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

writeFileSync(join(DIR, "REPORT-4.md"), out);
console.log(out);
