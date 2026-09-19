# Ceiling measurement, run 3 — pre-registration

**Written 2026-09-19, before any model had answered a task under these settings.**
**Supersedes:** PREREG-2 for this run only. Run 2's rule and result stand as
written and are not edited.
**Run once, by this project. Not a feature, does not ship, no user runs it** (SPEC §28).

## The question this run exists to answer

Run 2 returned NEGATIVE: no pair of Qwen2.5-Coder-7B, DeepSeek-Coder-6.7B and
Llama-3.1-8B reached a ceiling of 6 of 60.

The obvious objection is that this is a fact about those three models rather
than about councils. It is a fair objection, and an exploratory analysis after
run 2 gave it a shape:

| pair | both fail (observed) | expected if independent | ratio | φ |
|---|---|---|---|---|
| qwen + deepseek | 10 | 4.0 | 2.52× | 0.53 |
| qwen + llama | 12 | 6.1 | 1.98× | 0.47 |
| deepseek + llama | 14 | 7.4 | 1.90× | 0.50 |

Had their failures been independent, the qwen+deepseek ceiling would have been
**10 of 60** and run 2 would have returned PROCEED. The entire negative result
is the cost of correlated failure.

So the question is no longer "does a council help". It is **does a pair with
decorrelated failures exist in this hardware class**, and all three models in
run 2 answer the same way: one shot, no deliberation.

Gemma-4-12B is the strongest locally available test of that. Different vendor,
different architecture, and — the part the other three had in common — a
different way of producing an answer. Run 1 could not measure it because 29 of
60 answers truncated; the KV cache control has since made it fast enough to
finish.

## What changed from run 2

**All four models are re-run from scratch under one server configuration.**
Nothing is reused. Run 2's answers were produced without flash attention and
with an fp16 KV cache; comparing them against answers produced with a q8_0
cache would invite precisely the objection this run exists to close — that a
difference between models was really a difference between configurations.

| | run 2 | run 3 |
|---|---|---|
| server flags | `-ngl 999` | `-ngl 999 -fa on -ctk q8_0 -ctv q8_0` |
| models | qwen, deepseek, llama | + gemma |
| gemma budget | — | 8,192 tokens, context 8,192 |
| results directory | `results/` | `results/r3/` |

The configuration change is licensed by a control, not by preference:
Qwen scored 46/60 under both, with **zero verdict flips** and 52 of 60 answers
byte-identical, eleven times faster. The same control rejected `q4_0`, which
scored 0/60.

**Gemma's budget is 8× the others'** and this is deliberate. It is the only
reasoning model here; run 1 established that 3,072 tokens truncates it on half
the set, and a budget that prevents a model from answering measures the budget.
The comparison is between answers, not token counts. What the extra budget
costs in latency is reported separately and is not netted against anything.

**Unchanged:** the task set (`data/tasks.jsonl`, seed 20260918, selected before
run 1, byte-identical), greedy sampling at temperature 0, the prompt, the
grader, the container, the extractor, the ceiling definition, the per-pair
thresholds, and the validity conditions.

## Metrics, including the ones that were exploratory last time

Per pair, as before:

- `ceiling = oracle − best_single = min(only_A, only_B)`

Newly **pre-registered** rather than computed after the fact, because they are
now the primary question:

- `both_fail` observed, against its expectation under independent failure;
- **φ**, the correlation between the two models' failure indicators;
- the ceiling that independence would have produced.

## The rule, fixed now

Per pair, at n = 60 — the same numbers runs 1 and 2 used:

| ceiling | verdict for that pair |
|---|---|
| ≤ 3 (5%) | below threshold |
| ≥ 6 (10%) | candidate |
| 4–5 | inconclusive at this n |

Cross-pair, as in PREREG-2: no candidate is a negative for this hardware class;
one candidate is the pair; several takes the highest ceiling, ties inside one
task broken by wall clock.

### And the correlation question, with its interpretation fixed in advance

This decides what may be *claimed*, not what gets built:

- **Every pair, including all three Gemma pairs, has φ ≥ 0.35** → failure
  correlation is a property of this model class rather than of a particular
  pair. Run 2's negative generalizes within this hardware class, and the
  objection "it was just those two models" is answered.
- **Any pair has φ < 0.20 and ceiling ≥ 6** → run 2's negative was
  pair-specific. The council question reopens with that pair, and a new
  pre-registration is written for it.
- **Any pair has φ < 0.20 but ceiling < 6** → decorrelation is achievable and
  is not sufficient, because the pair is strength-mismatched. Report both
  numbers; claim neither generalization.
- **Anything else** → report, claim no generalization.

φ is reported with its 95% interval. At n = 60 it is not a precise estimate and
will not be treated as one; the thresholds are deliberately far apart for that
reason.

## Validity conditions, unchanged from PREREG-2

1. **Every model answers every task.** More than 5 of 60 unanswered — truncated
   or errored — and that model was not measured; its pairs are reported invalid
   rather than scored, whatever the cells say.
2. **The blind spot.** For each pair, of the tasks the stronger model got
   wrong, the fraction the other never completed is reported beside the
   ceiling. Above 10% of that cell, the pair is invalid.
3. **Requests are streamed**, so no generation is abandoned by a client
   timeout, and **readiness is probed with the endpoint the run uses**, since
   `/v1/models` answers 200 while weights are still loading.
4. **New: the server configuration is proved before it is used.** Each model
   answers a known-answer question under its run-3 flags, and a configuration
   that gets it wrong does not run. A `q4_0` cache produced 15.1 tok/s of
   garbage and would have been reported as a speedup; SPEC §25.3 and invariant
   44 now require this of the product, and the experiment holds itself to it.

An invalid pair is not a negative result. It is a measurement that did not
happen.

## Known limits, unchanged

- **Contamination.** All four models have almost certainly seen HumanEval.
  This inflates `both pass`, shrinks the discordant cells, and biases the
  measurement **toward a low ceiling** — toward not building. A negative is
  therefore weaker evidence than a positive would be. It also inflates the
  measured φ, since shared training data is one of the mechanisms being
  measured; this is a real confound and it is not corrected for.
- **One family, one hardware class.** Closed code tasks, 8GB, quantized.
  Nothing here speaks to the open-task half of the premise, where the claim is
  to surface meaningful divergence rather than to be right more often.
- **Quantized.** Absolute pass rates are not comparable to leaderboards; only
  differences between models are used.
