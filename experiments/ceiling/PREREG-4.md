# Ceiling measurement, run 4 — pre-registration

**Written 2026-09-20, before any of these four configurations had answered a task.**
**Supersedes:** nothing. Runs 1–3 stand as written.
**Run once, by this project. Not a feature, does not ship, no user runs it** (SPEC §28).

## The question, narrowed to one variable

Runs 2 and 3 returned NEGATIVE, and the exploratory analysis found the reason:
the models fail on the same tasks. φ between 0.47 and 0.58 across every pair,
`both fail` at roughly twice what independence predicts, and ceilings of 2–3
where independence would have given 8–10. **The negative is entirely the cost
of correlated failure**, not of weak models.

The standing objection — *maybe that is a fact about those particular models* —
is fair and has survived every attempt to test it locally. Gemma-4-12B was
brought in to answer it and could not be measured on 8GB, twice.

Every model measured so far answers the same way: one shot, no deliberation. So
the hypothesis worth testing is **does a model that produces answers a
different way fail on different tasks**, and the obstacle has always been that
changing the answering style also changed the vendor, the size and the training
data.

Both endpoints available here accept `chat_template_kwargs.enable_thinking`.
That makes a comparison possible that no pair of distinct models can offer:

> **The same weights, answering twice, once with deliberation and once without.**

Lineage, parameter count, training data and quantization are held exactly
equal, because they are the same file. One variable remains.

## The four configurations

| key | endpoint model | thinking | why |
|---|---|---|---|
| `q27-think` | `qwen3.8-27b` | on | |
| `q27-flat` | `qwen3.8-27b` | **off** | paired with `q27-think`: style isolated, weights identical |
| `qf-think` | `qwen3.8-flash-next` | on | |
| `qf-flat` | `qwen3.8-flash-next` | **off** | paired with `qf-think`: the same isolation, replicated on a second model |

Six pairs. Two of them (`q27-think`+`q27-flat`, `qf-think`+`qf-flat`) isolate
style with everything else fixed. The other four vary style and model together
and are reported for comparison, not as tests of the hypothesis.

Thinking is disabled with `chat_template_kwargs: {enable_thinking: false}`,
verified before this document was written: reasoning content drops to zero
characters on both endpoints while the answer stays correct.

## What this cannot answer

**Not whether to build a local council on 8GB.** These are 27B-class models on
other machines. Checkpoint B stays where runs 2 and 3 left it, and nothing here
reopens it.

**Not whether a different vendor decorrelates.** Everything here is Qwen 3.8.
Lineage is held fixed on purpose — that is what makes the style comparison
clean — and the cost is that the lineage question stays open.

## Unchanged from runs 2 and 3

The task set (`data/tasks.jsonl`, seed 20260918, selected before run 1,
byte-identical), the prompt, greedy sampling at temperature 0, one sample per
task, the grader, the container, the extractor, the ceiling definition, the
per-pair thresholds, and the validity conditions.

Budget is 8,192 tokens for every configuration, including the flat ones that
will not need it. A budget that differs between the two halves of a paired
comparison would measure the budget.

## Metrics

Per pair, as before: `ceiling = oracle − best_single = min(only_A, only_B)`,
`both_fail` against independence, **φ** with a 95% interval, and the ceiling
independence would have produced.

## The rule, fixed now

Per pair, at n = 60, the same numbers runs 1–3 used:

| ceiling | verdict |
|---|---|
| ≤ 3 (5%) | below threshold |
| ≥ 6 (10%) | candidate |
| 4–5 | inconclusive at this n |

### And the interpretation, fixed before the numbers exist

Decided on the **two style-isolated pairs only**. The other four confound style
with model and may not be used to support a claim about style, whatever they
show.

- **Both style-isolated pairs have φ < 0.30** → answering style decorrelates
  failure. A council should pair *modes*, not just models, and that is a design
  conclusion this project can act on.
- **Both have φ ≥ 0.45** → style does not decorrelate failure. The correlation
  survives holding everything else equal and varying only how the answer is
  produced, which makes it a property of the model rather than of the
  configuration, and weakens the Democracy premise further than runs 2 and 3
  did.
- **Both are between 0.30 and 0.45, or they disagree with each other** →
  inconclusive. Report both; claim nothing.

A ceiling clearing threshold on a style-isolated pair is **permission to run
the pre-registered efficacy experiment on that configuration**, not evidence
that Democracy works.

## Validity conditions

Carried over from PREREG-3, all four of them:

1. **Every configuration answers every task.** More than 5 of 60 unanswered —
   truncated or errored — and it was not measured; its pairs are reported
   invalid rather than scored, whatever the cells say.
2. **The blind spot.** For each pair, of the tasks the stronger side got wrong,
   the fraction the other never completed is reported beside the ceiling. Above
   10% of that cell, the pair is invalid.
3. **Requests are streamed**, and readiness is not assumed from a listing
   endpoint.
4. **The configuration is proved before it is used.** Each of the four answers
   a known-answer question under its exact request shape first, and one that
   gets it wrong does not run. For the two flat configurations this also
   confirms that thinking is actually off — a flag silently ignored by the
   server would turn this experiment into four copies of the same thing.

An invalid pair is not a negative result. It is a measurement that did not
happen.

## Known limits

- **Contamination.** Qwen 3.8 has almost certainly seen HumanEval. This
  inflates `both pass`, shrinks the discordant cells, and biases toward a low
  ceiling. It also inflates φ directly, since memorized items are answered the
  same way regardless of mode — which bites hardest on exactly the
  style-isolated comparison this run rests on. Not corrected for. Stated.
- **One family, one task type.** Closed code tasks, Qwen 3.8 only.
- **Remote.** The task set and the answers leave this machine for a private
  network. The tasks are public data; the harness would still classify these
  endpoints as REMOTE, because the gate follows the data rather than the
  address.
