import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL, SAMPLING } from "../models.mjs";

/**
 * Does agreement between two models mean anything when nothing can verify them?
 *
 * Applies PREREG-F1.md, fixed before any model answered. The code runs could
 * only compare verdicts; here the answers themselves are compared, which is
 * what makes false consensus measurable rather than inferred.
 */

const DIR = process.env["DEM_RESULTS_DIR"] ?? "factual/results";
const KEYS = ["q27-flat", "qf-flat", "llama"];

const tasks = readFileSync("factual/tasks.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ids = tasks.map((t) => t.id);
const byId = new Map(tasks.map((t) => [t.id, t]));
const n = tasks.length;

/**
 * The same normalization for grading and for agreement.
 *
 * Correctness is generous because the dataset supplies aliases; agreement is
 * strict because two models have to have actually said the same thing. Loose
 * agreement matching would turn near misses into consensus and inflate the one
 * cell this run exists to measure.
 */
function normalize(text) {
  return text
    .toLowerCase()
    // Diacritics folded. The dataset's own aliases are inconsistent about them
    // — the same name appears as both "valery" and "valéry" — and a model
    // writing one form should not be wrong for it.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // All punctuation, apostrophes included. PREREG-F1 says "punctuation
    // stripped"; the first implementation deliberately kept apostrophes, so
    // "d'Estaing" never matched the dataset's "d estaing" and a correct answer
    // was counted as false consensus — in the cell the whole run turns on.
    // This makes the code match the written rule; it does not change the rule.
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A model that declines has not agreed with anything (validity condition 5). */
function isRefusal(text) {
  const t = normalize(text);
  return (
    t === "unknown" ||
    t === "" ||
    /^(i (do not|don t|dont) know|not sure|no idea|cannot answer|can t answer)/.test(t)
  );
}

const graded = new Map();

for (const key of KEYS) {
  const path = join(DIR, `answers-${key}.jsonl`);
  if (!existsSync(path)) {
    console.error(`missing ${path} — run: node factual/run.mjs ${KEYS.join(" ")}`);
    process.exit(2);
  }

  const answers = new Map();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    answers.set(record.id, record);
  }

  const outcome = new Map();
  for (const id of ids) {
    const record = answers.get(id);
    if (!record || record.error) { outcome.set(id, { state: "missing" }); continue; }

    const raw = (record.answer ?? "").trim();
    if (isRefusal(raw)) { outcome.set(id, { state: "refused" }); continue; }

    const said = normalize(raw);
    const correct = byId.get(id).aliases.some((alias) => normalize(alias) === said);
    outcome.set(id, { state: "answered", said, raw, correct });
  }
  graded.set(key, outcome);
}

const count = (key, predicate) => [...graded.get(key).values()].filter(predicate).length;
const answered = (key) => count(key, (o) => o.state === "answered");
const correct = (key) => count(key, (o) => o.correct);
const refused = (key) => count(key, (o) => o.state === "refused");
const missing = (key) => count(key, (o) => o.state === "missing");

// Validity 1: a model that did not answer was not measured. A refusal counts
// as answering — declining is a behaviour, not a failure to be asked.
const UNMEASURED_LIMIT = Math.floor(n * 0.05);
const modelValid = (key) => missing(key) <= UNMEASURED_LIMIT;

function analyse(a, b) {
  const A = graded.get(a);
  const B = graded.get(b);

  const cell = { agreeRight: [], agreeWrong: [], disagree: [], refused: [], missing: [] };
  for (const id of ids) {
    const x = A.get(id);
    const y = B.get(id);
    if (x.state === "missing" || y.state === "missing") { cell.missing.push(id); continue; }
    // One side declining is not consensus, and not disagreement either.
    if (x.state === "refused" || y.state === "refused") { cell.refused.push(id); continue; }
    if (x.said !== y.said) { cell.disagree.push(id); continue; }
    (x.correct ? cell.agreeRight : cell.agreeWrong).push(id);
  }

  const agreed = cell.agreeRight.length + cell.agreeWrong.length;
  const falseConsensus = agreed ? cell.agreeWrong.length / agreed : 0;

  // The operational form: abstain whenever the two differ, or either declines.
  const coverage = agreed / n;
  const selectiveAccuracy = agreed ? cell.agreeRight.length / agreed : 0;

  // Against the better model answering everything on its own.
  const soloA = correct(a) / n;
  const soloB = correct(b) / n;
  const solo = Math.max(soloA, soloB);
  const soloErrors = n - Math.max(correct(a), correct(b));
  const errorsRemaining = cell.agreeWrong.length;
  const errorsRemoved = soloErrors ? (soloErrors - errorsRemaining) / soloErrors : 0;

  // Continuity with runs 1-4: the accuracy ceiling and failure correlation,
  // computed over questions both models actually answered.
  const scored = ids.filter(
    (id) => A.get(id).state === "answered" && B.get(id).state === "answered",
  );
  let both = 0, onlyA = 0, onlyB = 0, neither = 0;
  for (const id of scored) {
    const x = A.get(id).correct;
    const y = B.get(id).correct;
    if (x && y) both++;
    else if (x) onlyA++;
    else if (y) onlyB++;
    else neither++;
  }
  const ceiling = Math.min(onlyA, onlyB);
  const num = neither * both - onlyA * onlyB;
  const den = Math.sqrt((neither + onlyA) * (neither + onlyB) * (both + onlyA) * (both + onlyB));
  const phi = den === 0 ? 0 : num / den;

  const blind = ids.filter((id) => {
    const strongKey = soloA >= soloB ? a : b;
    const otherKey = strongKey === a ? b : a;
    return graded.get(strongKey).get(id).correct === false &&
      graded.get(otherKey).get(id).state === "missing";
  });
  const strongFails = ids.filter((id) => graded.get(soloA >= soloB ? a : b).get(id).correct === false);
  const blindFraction = strongFails.length ? blind.length / strongFails.length : 0;

  const valid = modelValid(a) && modelValid(b) && blindFraction <= 0.10;
  const crossLineage = ALL[a].family !== ALL[b].family;

  return { a, b, cell, agreed, falseConsensus, coverage, selectiveAccuracy,
           solo, soloErrors, errorsRemaining, errorsRemoved, ceiling, phi,
           both, onlyA, onlyB, neither, blindFraction, valid, crossLineage };
}

const pairs = [];
for (let i = 0; i < KEYS.length; i++)
  for (let j = i + 1; j < KEYS.length; j++)
    pairs.push(analyse(KEYS[i], KEYS[j]));

// PREREG-F1 decides on the cross-lineage pairs; the same-lineage pair is
// reported for comparison and carries no conclusion of its own.
const deciding = pairs.filter((p) => p.crossLineage && p.valid);

const pct = (x) => `${(x * 100).toFixed(1)}%`;

let verdictA;
if (deciding.length === 0) {
  verdictA = "**No valid cross-lineage pair.** Nothing may be claimed.";
} else if (deciding.every((p) => p.falseConsensus <= 0.10)) {
  verdictA =
    `**Agreement is informative.** When these models agree, they are wrong ` +
    `${deciding.map((p) => pct(p.falseConsensus)).join(" and ")} of the time. A council can serve ` +
    `as a confidence signal where no verifier exists, which is a real niche for this harness — ` +
    `not the corrector it was designed as, but a detector worth having.`;
} else if (deciding.some((p) => p.falseConsensus >= 0.25)) {
  verdictA =
    `**Agreement is not informative.** These models agree on a wrong answer ` +
    `${deciding.map((p) => pct(p.falseConsensus)).join(" and ")} of the time they agree. One in ` +
    `four is not a signal anyone can act on, and cross-validation between models is closed as an ` +
    `accuracy mechanism — on verifiable tasks by runs 1-4, and here on unverifiable ones.`;
} else {
  verdictA =
    `**Partial.** False consensus is ${deciding.map((p) => pct(p.falseConsensus)).join(" and ")}, ` +
    `between the thresholds fixed in PREREG-F1. Reported; no claim either way.`;
}

let verdictB;
if (deciding.length === 0) {
  verdictB = "Not assessable.";
} else if (deciding.every((p) => p.errorsRemoved >= 1 / 3 && p.coverage >= 0.70)) {
  verdictB =
    `**The detector is worth building.** Abstaining on disagreement removes ` +
    `${deciding.map((p) => pct(p.errorsRemoved)).join(" and ")} of the better model's errors while ` +
    `still answering ${deciding.map((p) => pct(p.coverage)).join(" and ")} of questions.`;
} else {
  verdictB =
    `**The detector is not worth building at this cost.** Abstaining removes ` +
    `${deciding.map((p) => pct(p.errorsRemoved)).join(" and ")} of errors at ` +
    `${deciding.map((p) => pct(p.coverage)).join(" and ")} coverage, short of the threshold fixed ` +
    `in PREREG-F1 (one third of errors at 70% coverage).`;
}

const out = [
  "# Factual cross-validation — results",
  "",
  `**Run:** ${new Date().toISOString().slice(0, 10)}  ·  **n = ${n}**  ·  TriviaQA rc.nocontext, seed 20260920`,
  `**Sampling:** greedy, temperature ${SAMPLING.temperature}, seed ${SAMPLING.seed}, 1 sample per question`,
  "**Grading:** the dataset's own alias lists. No model grades anything.",
  "**Rule:** fixed in [PREREG-F1.md](PREREG-F1.md) before any model answered",
  "",
  "## Models",
  "",
  "| model | family | correct | answered | refused | missing |",
  "|---|---|---|---|---|---|",
  ...KEYS.map((k) =>
    `| ${ALL[k].label} | ${ALL[k].family} | ${correct(k)}/${n} (${pct(correct(k) / n)}) | ` +
    `${answered(k)} | ${refused(k)} | ${missing(k)} |`),
  "",
  "## When two models agree, is the agreement right?",
  "",
  "| pair | cross-lineage | agree right | **agree wrong** | disagree | one refused | **false consensus** |",
  "|---|---|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a} + ${p.b} | ${p.crossLineage ? "**yes**" : "no"} | ${p.cell.agreeRight.length} | ` +
    `**${p.cell.agreeWrong.length}** | ${p.cell.disagree.length} | ${p.cell.refused.length} | ` +
    `**${pct(p.falseConsensus)}** |`),
  "",
  "False consensus is `agree wrong / (agree wrong + agree right)`: given that they agreed, how often",
  "that agreement was wrong. It is the number a user would be trusting.",
  "",
  "## If the council abstains whenever its members disagree",
  "",
  "| pair | coverage | accuracy when it answers | best single model | errors removed |",
  "|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a} + ${p.b} | ${pct(p.coverage)} | ${pct(p.selectiveAccuracy)} | ${pct(p.solo)} | ` +
    `${pct(p.errorsRemoved)} of ${p.soloErrors} |`),
  "",
  "## Accuracy ceiling and failure correlation, for continuity with runs 1-4",
  "",
  "| pair | both | only A | only B | neither | ceiling | phi |",
  "|---|---|---|---|---|---|---|",
  ...pairs.map((p) =>
    `| ${p.a} + ${p.b} | ${p.both} | ${p.onlyA} | ${p.onlyB} | ${p.neither} | ` +
    `**${p.ceiling}** (${pct(p.ceiling / n)}) | ${p.phi.toFixed(2)} |`),
  "",
  "## A — does agreement mean anything?",
  "",
  "> " + verdictA,
  "",
  "## B — is abstaining on disagreement worth it?",
  "",
  "> " + verdictB,
  "",
  "## Validity",
  "",
  `**1. Every model answered** (at most ${UNMEASURED_LIMIT} of ${n} missing):`,
  "",
  ...KEYS.map((k) => `- ${k}: ${missing(k)} missing — ${modelValid(k) ? "ok" : "**fails**"}`),
  "",
  "**2. The blind spot:**",
  "",
  ...pairs.map((p) =>
    `- ${p.a} + ${p.b}: ${pct(p.blindFraction)} of the stronger model's errors were never attempted ` +
    `by the other — ${p.blindFraction <= 0.10 ? "ok" : "**fails**"}`),
  "",
  "**5. Refusals are not answers.** Counted above and excluded from the agreement cells, so two",
  "models declining is never scored as consensus.",
  "",
  "## A sample of false consensus",
  "",
  "The cases that matter: both models said the same thing, confidently, and it was wrong.",
  "",
  ...(() => {
    const worst = pairs.filter((p) => p.crossLineage)[0];
    if (!worst) return ["(no cross-lineage pair)"];
    return worst.cell.agreeWrong.slice(0, 12).flatMap((id) => {
      const task = byId.get(id);
      const said = graded.get(worst.a).get(id).raw;
      return [`- **${task.question}**`, `  - both said: \`${said}\`  ·  correct: \`${task.answer}\``];
    });
  })(),
  "",
].join("\n");

writeFileSync(join(DIR, "REPORT.md"), out);
console.log(out);
