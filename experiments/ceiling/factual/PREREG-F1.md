# Factual cross-validation — pre-registration

**Written 2026-09-20, before any model answered a question from this set.**
**Run once, by this project. Not a feature, does not ship, no user runs it** (SPEC §28).

## Why this exists, and why it is the last one

Four runs on code tasks returned NEGATIVE. No pairing of models raised accuracy
— ceilings of 0 to 4 out of 60 — and the reason was consistent: the models fail
on the same tasks. φ from 0.47 to 0.90 across every axis tried, including the
same weights with and without deliberation.

But code is the one family in SPEC §28 that has a **deterministic verifier**.
The tests decide. A second model sits on top of a judge that is already doing
the work, and arm C existed precisely to separate those two contributions;
measured, the verifier was nearly all of it.

Where there is no verifier — a factual claim, a judgment — cross-checking
between models is the **only** check available. That case has never been
measured here, and it is the last place the harness's founding premise could
still hold.

If it fails here too, "cross-validation between models raises accuracy" is
closed, and the project's direction changes on evidence rather than on mood.

## What is measured, and why it differs from the code runs

The code runs could only compare **verdicts** — pass or fail. Two models could
both fail with completely different wrong programs and it would look identical
to two models failing the same way. A short factual answer can be compared
directly, so this run measures the thing that actually matters without a
verifier:

> **When two models agree, how often is the agreement wrong?**

and its operational form:

> **If a council abstains whenever its members disagree, how much error does
> that remove, and how many questions does it cost?**

That is the product question. A council with no verifier cannot be a corrector;
at best it is a detector, and a detector is worth having only if its alarm is
informative and its silence is trustworthy.

### Primary metrics

For each pair, over n = 300, with every question graded against the dataset's
alias list:

| | |
|---|---|
| `agree_right` | both give an answer that matches; agreement is correct |
| **`agree_wrong`** | both give the *same* answer and it is wrong — **false consensus** |
| `disagree` | the two answers differ |
| **`false consensus rate`** | `agree_wrong / (agree_wrong + agree_right)` — given that they agreed, how often that was wrong |
| `abstain coverage` | fraction of questions answered when disagreement means abstain |
| `selective accuracy` | accuracy on the answered fraction |
| `error removed` | single-model error rate minus selective error rate |

Also reported, for continuity with runs 1–4: per-pair `ceiling`, φ, and
`both_fail` against independence.

### Answer agreement, defined before any answers exist

Two answers agree when their normalized forms are equal: lowercased, articles
(`a`, `an`, `the`) removed, punctuation stripped, whitespace collapsed. The
same normalization is used for grading against aliases.

This is deliberately strict about *agreement* and lenient about *correctness*:
an alias list makes correctness generous, while agreement requires the two
models to have actually said the same thing. Loose agreement matching would
turn near-misses into consensus and inflate the very cell this run is about.

**No model grades anything.** An LLM judge would put a fourth correlated
judgment inside a measurement about correlated judgments.

## The models

| key | what | why |
|---|---|---|
| `q27-flat` | Qwen3.8-27B, no thinking | strong general model |
| `qf-flat` | Qwen3.8-Flash-Next, no thinking | strong, same lineage — the control for "same family" |
| `llama` | Llama-3.1-8B-Instruct Q6_K, local | different lineage, general rather than code-specialized |

Thinking is off everywhere. Run 4 measured deliberation buying no accuracy at
five times the wall clock, and a factual recall question is not where that
would change.

The two code-specialized local models from runs 2 and 3 are excluded: a code
model answering trivia measures the mismatch, not the hypothesis.

Three pairs. `q27-flat`+`llama` and `qf-flat`+`llama` cross lineage;
`q27-flat`+`qf-flat` does not and is the control.

## The rule, fixed now

Every threshold below is about the **cross-lineage pairs**. The same-lineage
pair is reported for comparison and may not carry a conclusion on its own.

**A. Does agreement mean anything?**

| false consensus rate | verdict |
|---|---|
| ≤ 10% | **agreement is informative.** A council can be used as a confidence signal where no verifier exists, and that is a real niche for this harness. |
| ≥ 25% | **agreement is not informative.** One in four agreed answers being wrong is not a signal anyone can act on, and cross-validation is closed as an accuracy mechanism. |
| 10–25% | partial. Report the number; no claim either way. |

**B. Is abstaining on disagreement worth it?**

| error removed at that coverage | verdict |
|---|---|
| removes ≥ 1/3 of the single model's errors while keeping ≥ 70% coverage | **the detector is worth building** |
| anything less | it is not |

Both A and B are reported whatever they show. B can pass while A fails, or the
reverse; they are different products and neither substitutes for the other.

**C. Accuracy, for continuity.** The ceiling thresholds from runs 1–4 apply
unchanged at n = 300: ≤ 5% below threshold, ≥ 10% candidate.

## Validity conditions

Carried forward, and one added for this task type:

1. **Every model answers every question.** More than 5% unanswered — empty,
   truncated or errored — and that model was not measured; its pairs are
   invalid rather than scored.
2. **The blind spot.** Of the questions the stronger model got wrong, the
   fraction the other never completed is reported beside the result. Above 10%,
   the pair is invalid.
3. **Requests are streamed**, and readiness is not assumed from a listing
   endpoint.
4. **Each configuration is proved before it is used**, on a known-answer
   question.
5. **New: refusals are not answers.** A model that says it does not know has
   not agreed with anything. Refusals are counted and excluded from the
   agreement cells rather than being treated as a matching wrong answer, which
   would manufacture consensus out of two models declining.

An invalid pair is not a negative result. It is a measurement that did not
happen.

## Known limits

- **Contamination.** TriviaQA is old and public, so all three models have very
  likely seen it. This inflates `agree_right` and therefore *deflates* the
  false consensus rate — the bias runs toward concluding that agreement is
  informative. That is the opposite of the direction the code runs were biased
  in, and it is stated here rather than discovered later.
- **Recall, not reasoning.** TriviaQA rewards memorized facts. Two models with
  overlapping training data agreeing on a recalled fact is close to a tautology;
  where they disagree is where the signal is.
- **One task type.** Short-answer factual recall is not the same as an open
  judgment, and this run says nothing about the open-task half of the premise.
- **Remote.** Questions and answers leave this machine for a private network.
  Public data, but the gate follows the data, so these endpoints are REMOTE.
