# Ceiling measurement, run 2 - pre-registration

**Written 2026-09-18, before either new model had answered any task.**
**Supersedes:** the rule in [README.md](README.md) for this pair only. Run 1's
rule and result stand as written and are not edited.
**Run once, by this project. Not a feature, does not ship, no user runs it**
(SPEC 28).

## Why a second run

Run 1's rule produced `INCONCLUSIVE` and its own validity section explains why
the number should not be acted on: Gemma-4-12B answered 31 of 60 tasks and
passed every one of them, with all 29 failures being truncations at the token
budget. Of the 14 tasks Qwen got wrong - the only tasks where a council can
gain anything - Gemma never finished 10. The ceiling was measured on 4 of the
14 tasks that could contribute to it.

The pre-registration says a rule may not be edited after seeing a result, and a
new one must be committed instead. This is that document.

Run 1 is not discarded. It answered a different question than the one it was
asked, and the answer is worth keeping: **a reasoning model is not a viable
council member on 8GB.** At 4.7 tok/s and roughly 10x the tokens per answer, a
council containing one costs 650+ hours for the experiment it is supposed to
enable. That is a result about local councils on consumer hardware, recorded in
`results/REPORT.md`.

## What changed, and what deliberately did not

Changed:

- **The models.** Two additional non-reasoning models of comparable size, from
  families that do not share Qwen's training lineage.
- **n stays 60, the task set stays byte-identical.** `data/tasks.jsonl`, seed
  20260918, selected before run 1. Re-rolling the sample after seeing a result
  is the same offence as re-rolling a threshold.

Deliberately unchanged:

- greedy sampling, temperature 0, one sample per task;
- 1,024-token budget, the same one Qwen answered every task inside;
- the grader, the container, the extractor;
- truncation counts as failure; a failed request does not;
- the ceiling definition and the thresholds below are the same numbers run 1
  used.

## The models

| key | model | family | why it is here |
|---|---|---|---|
| `qwen` | Qwen2.5-Coder-7B-Instruct Q6_K | Qwen | run 1's answers are reused unchanged; the task set and settings are identical |
| `deepseek` | DeepSeek-Coder-6.7B-Instruct Q6_K | DeepSeek | code specialist of comparable published strength, different lineage |
| `llama` | Meta-Llama-3.1-8B-Instruct Q6_K | Llama | general model, weaker on code by published figures, included to test whether a *differently* wrong model contributes more than a similarly strong one |

Three models give three pairs from one run. The marginal cost of the third is
about 30 minutes, and the question "which pair should the real experiment use"
cannot be answered by measuring one pair.

**Qwen's run 1 answers are reused rather than regenerated.** Same task set,
same seed, same budget, same prompt, greedy decoding. Regenerating them would
cost 33 minutes to reproduce bytes that are already on disk, and any difference
would indicate non-determinism worth investigating rather than a better number.

## The metric, unchanged from run 1

For a pair (A, B), per task each model passes or fails:

- `best_single` = max(A passes, B passes)
- `oracle` = both + only_A + only_B
- **`ceiling` = oracle - best_single = min(only_A, only_B)**

A pair where one model is better at everything has a ceiling of zero, however
good either model is.

## The rule, fixed now

Applied **per pair**, at n = 60:

| ceiling | decision for that pair |
|---|---|
| <= 3 tasks (5%) | premise not supported for that pair |
| >= 6 tasks (10%) | that pair is a candidate for the real experiment |
| 4-5 tasks | inconclusive at this n for that pair |

And across the three pairs, fixed now so that the best pair is not chosen after
the fact by whatever rule flatters it:

- **If no pair reaches 6**, Checkpoint B is answered **negative** for local
  councils in this hardware class. Do not build the v0.2-alpha council. Record
  it and move on.
- **If exactly one pair reaches 6**, that pair is the one the pre-registered
  efficacy experiment runs on.
- **If more than one reaches 6**, the pair with the highest ceiling is used, and
  if two are within one task of each other the cheaper pair in wall-clock is
  used. Ties are not broken by which result is more interesting.

A ceiling above threshold is **permission to run the real experiment, not
evidence that Democracy works.** It says headroom exists. Whether a council can
capture any of it is what `docs/EFFICACY_PREREG.md` measures.

## Validity conditions, stated in advance

Run 1 failed a precondition nobody had written down. These are written down:

1. **Every model answers every task.** A model that truncates or errors on more
   than 5 of 60 tasks has not been measured, and its pairs are reported as
   invalid rather than scored - whatever number the cells produce.
2. **The blind-spot check.** For each pair, of the tasks the stronger model got
   wrong, the fraction the other model did not complete is reported next to the
   ceiling. Above 10% of that cell, the pair is reported as invalid.
3. **Requests are streamed**, so no generation is abandoned by a client
   timeout. Run 1 lost 47 of 60 answers that way and the loss was
   indistinguishable from model failure.

An invalid pair is not a negative result. It is a measurement that did not
happen.

## Known limits, unchanged

- **Contamination.** All three models were very likely trained on HumanEval.
  That inflates `both` and shrinks the discordant cells, biasing this
  measurement **toward a low ceiling** - toward not building. Safer for a screen
  whose job is to prevent wasted work, but it means a low result is weaker
  evidence than a high one.
- **One family, one hardware class.** Code only, 8GB, quantized. This screens
  the configuration that can actually run here, not Democracy in general.
- **Quantized.** Absolute pass rates are not comparable to leaderboards; only
  the differences between models are used.
