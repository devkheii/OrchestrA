# Ceiling measurement — a screen for Checkpoint B

**Written 2026-09-18, before any model had answered any task.**
**Run once, by this project. Not a feature, does not ship, no user ever runs it** (SPEC §28).
**Governs:** whether the v0.2-alpha council in `docs/SPEC.md` §30 gets built at all.

This is not the pre-registered efficacy experiment. That is
[`docs/EFFICACY_PREREG.md`](../../docs/EFFICACY_PREREG.md), it needs a council
engine, a DecisionEnvelope, comparators and a counterexample runner, and it
costs 30–40 hours. This is the cheap screen that runs first and can make all of
that unnecessary.

## The question

v0.2-alpha rests on one premise: **two models deciding together beat one model
deciding alone.** Every component on that milestone — blind Round 1, the
envelope, the comparators, reconsideration — is machinery for converting
disagreement into a better answer. If there is no better answer available to
convert, the machinery cannot help, however well it is built.

The *ceiling* is the amount available. It is measured without a council,
without voting, without a sandbox adapter: run each model alone, grade both,
and count.

## The metric

For each task, each model either passes the tests or does not. Four cells:

|            | gemma pass | gemma fail |
|---|---|---|
| **qwen pass** | `both`     | `only_qwen` |
| **qwen fail** | `only_gemma` | `neither`  |

- `best_single` = max(qwen passes, gemma passes)
- `oracle` = `both + only_qwen + only_gemma` — a perfect selector that always
  picks the model that happens to be right
- **`ceiling` = `oracle − best_single`**, which reduces to
  `min(only_qwen, only_gemma)`

No council can exceed `oracle`, because no council can be right where both
members are wrong. So `ceiling` is the entire headroom over just using the
better model — and the reduction to a minimum is the point: **a pair where one
model is simply better at everything has a ceiling of zero**, no matter how
good either model is.

## The rule, fixed now

At n = 60, over HumanEval+ (`OriginFmt`, v0.1.10):

| ceiling | decision |
|---|---|
| **≤ 3 tasks (5%)** | Premise not supported for this pair. Checkpoint B is answered **negative** without building the council. Record the result; try a different pair, or drop Democracy mode. |
| **≥ 6 tasks (10%)** | Proceed: build the v0.2-alpha council and run the full pre-registered experiment. |
| **4–5 tasks** | Inconclusive at this n. Extend to all 163 tasks before deciding — and only then. |

A ceiling above the threshold is **permission to run the real experiment, not
evidence that Democracy works.** It says headroom exists; whether a council can
capture any of it is what `EFFICACY_PREREG.md` measures. Nothing here may be
read as a result about the harness.

Editing this table after seeing results invalidates the screen. Write a new one
and re-run.

## Decisions that could otherwise be made after the fact

- **Sampling is greedy** (temperature 0, fixed seed, one sample per task). Not
  because it is realistic, but because pass@1 with sampling turns a difference
  between models into a difference between coin flips at this n.
- **A truncated answer counts as a failure.** A model that does not deliver
  inside its token budget has not solved the task. Gemma's budget is 3× Qwen's
  precisely so that this measures the model and not the budget; the truncation
  count is reported either way.
- **A failed HTTP request is not a failure.** It is recorded as an error and
  re-run. Infrastructure noise must not land in the cell being measured.
- **An answer with no extractable code counts as a failure**, and the count is
  reported separately. The same extractor runs on both models — an extractor
  that favours one would manufacture exactly the asymmetry being measured.
- **Reasoning tokens are never graded as code.** Gemma returns them in a
  separate field and they stay there (the same line SPEC invariant 35 draws).

## Known limits of this screen

- **Contamination.** Both models were very likely trained on HumanEval. That
  inflates `both` and shrinks the discordant cells, so this measurement is
  **biased toward a low ceiling** — toward not building. That is the safer
  direction for a screen whose job is to prevent wasted work, but it means a
  low result is weaker evidence than a high one.
- **One family, one pair.** Code only, Qwen+Gemma only. A different pair, or an
  open-ended task family, can have a different ceiling. This screens the
  configuration that can actually run on the measured 8GB machine
  (`EFFICACY_PREREG.md` §3.3), not Democracy in general.
- **Quantized.** Q6_K and Q4_K_M, not the published fp16 numbers. Absolute pass
  rates here are not comparable to leaderboards; only the difference is used.

## Running it

```sh
node select.mjs            # task set → data/tasks.jsonl (seeded, committed)
node selftest.mjs          # the grader must pass the reference solutions first
node run.mjs qwen          # ~6 min
node run.mjs gemma         # ~100 min
node report.mjs            # the four cells and the decision
```

Generation is batched by model because both models are ~7.5GB and the card has
8192 MiB, so they are never resident together. Answers are appended as they
arrive and a re-run skips what is already there, because an interruption two
hours in must not cost two hours.

Grading executes model-written code, so it runs in a container with no network
and no privileges — SPEC §8.4 requires that of counterexample execution, and
the experiment that decides whether to build that should not be held to a
looser standard than the thing it decides about.

---

## Excluded models

Recorded rather than dropped. A model that leaves this list silently looks like
one that was never tried.

### Gemma-4-12B-it Q4_K_M — excluded 2026-09-20, after run 3

**Not measurable on this hardware.** Three attempts:

| | budget | throughput | answered | truncated | wall clock |
|---|---|---|---|---|---|
| run 1 | 3,072 | 3.8 tok/s | 31/60 | 29 | 9.1 h |
| run 3 | 8,192 | ~13 tok/s | 27/60 | 33 | 4.6 h |

Quadrupling the budget and nearly quadrupling the throughput did not move it.
It needs more tokens per answer than an 8GB card can carry at a context that
fits, so it fails validity condition 1 every time — more than 5 of 60
unanswered means the model was not measured, whatever the cells say.

**This is a statement about the deployment, not about the model.** Gemma is not
bad at these tasks; on the 27 it finished in run 3 it passed 27. It is
unmeasurable here, and on a card with more VRAM the question would be open
again.

**What its exclusion does not change.** Runs 2 and 3 were decided on valid
pairs only, so no verdict moves. What is lost is the question Gemma was brought
in to answer: whether a model that produces answers a *different way* fails on
different tasks. All three remaining models answer in one shot, and all three
pairs of them correlate at phi 0.49–0.58.

**What must not be recovered later.** Gemma's pairs show phi 0.26–0.36 and one
of them reaches a ceiling of 6, which is the threshold. Those numbers are
artifacts of the truncations: a truncated answer is scored as a failure, those
failures land on tasks unrelated to where the other model fails, and that
pushes phi down and the ceiling up mechanically. They are the most encouraging
numbers in the experiment and they are not evidence of anything.

