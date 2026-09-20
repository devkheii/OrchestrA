# Ceiling measurement, run 4 - results

**Run:** 2026-09-20  ·  **n = 60**  ·  HumanEval+ OriginFmt v0.1.10
**Sampling:** greedy, temperature 0, seed 20260918, 1 sample per task
**Server:** `-ngl 999 -fa on -ctk q8_0 -ctv q8_0`, identical for every model
**Rule:** fixed in [PREREG-4.md](PREREG-4.md) before any model answered under these settings

## Models

| model | family | passes | | answered | truncated | no code | error | budget | wall clock |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3.8-27B (thinking) server-side | Qwen3.8 | 54/60 | 90.0% | 57/60 | 3 | 0 | 0 | 8192 | 61 min |
| Qwen3.8-27B (no thinking) server-side | Qwen3.8 | 55/60 | 91.7% | 60/60 | 0 | 0 | 0 | 8192 | 12 min |
| Qwen3.8-Flash-Next (thinking) server-side | Qwen3.8 | 55/60 | 91.7% | 56/60 | 4 | 0 | 0 | 8192 | 34 min |
| Qwen3.8-Flash-Next (no thinking) server-side | Qwen3.8 | 55/60 | 91.7% | 60/60 | 0 | 0 | 0 | 8192 | 8 min |

## Pairs

| pair | isolates style | both | only A | only B | neither | best | oracle | **ceiling** | verdict |
|---|---|---|---|---|---|---|---|---|---|
| q27-think + q27-flat | **yes** | 54 | 0 | 1 | 5 | 55 | 55 | **0** (0.0%) | INVALID |
| q27-think + qf-think | no | 54 | 0 | 1 | 5 | 55 | 55 | **0** (0.0%) | INVALID |
| q27-think + qf-flat | no | 53 | 1 | 2 | 4 | 55 | 56 | **1** (1.7%) | INVALID |
| q27-flat + qf-think | no | 54 | 1 | 1 | 4 | 55 | 56 | **1** (1.7%) | INVALID |
| q27-flat + qf-flat | no | 53 | 2 | 2 | 3 | 55 | 57 | **2** (3.3%) | below threshold |
| qf-think + qf-flat | **yes** | 54 | 1 | 1 | 4 | 55 | 56 | **1** (1.7%) | below threshold |

The 4 pairs marked "no" differ in model as well as in mode. They are reported for
comparison and, by PREREG-4, may not support a claim about answering style.

## Failure correlation

The primary question of this run: do these models fail on the same tasks more than chance,
and would independence have changed the verdict?

| pair | both fail | expected if independent | ratio | **phi** [95%] | ceiling | ceiling if independent |
|---|---|---|---|---|---|---|
| q27-think + q27-flat | 5 | 0.5 | 10.00x | **0.90** [0.84, 0.94] | 0 | 4.5 |
| q27-think + qf-think | 5 | 0.5 | 10.00x | **0.90** [0.84, 0.94] | 0 | 4.5 |
| q27-think + qf-flat | 4 | 0.5 | 8.00x | **0.70** [0.55, 0.81] | 1 | 4.5 |
| q27-flat + qf-think | 4 | 0.4 | 9.60x | **0.78** [0.66, 0.86] | 1 | 4.6 |
| q27-flat + qf-flat | 3 | 0.4 | 7.20x | **0.56** [0.36, 0.72] | 2 | 4.6 |
| qf-think + qf-flat | 4 | 0.4 | 9.60x | **0.78** [0.66, 0.86] | 1 | 4.6 |

At n = 60 phi is a width, not an estimate. PREREG-4 set the thresholds far apart for that reason.

## Decision

> **NEGATIVE** - no pair reaches the threshold. Checkpoint B stays answered negative for local councils in this hardware class.

## What may be claimed

> **Nothing may be claimed about answering style.** The rule decides on the two style-isolated pairs and 1 of them is valid. The four confounded pairs vary style and model together and cannot stand in for them.

## Validity

**1. Every model answers every task** (at most 5 of 60 unanswered):

- q27-think: answered 57/60 - ok
- q27-flat: answered 60/60 - ok
- qf-think: answered 56/60 - ok
- qf-flat: answered 60/60 - ok

**2. The blind spot** - of the tasks the stronger model got wrong, how many did the other never complete (limit 10%):

- q27-think + q27-flat: 3/5 of q27-flat's failures were never completed by q27-think - **fails**
- q27-think + qf-think: 3/5 of qf-think's failures were never completed by q27-think - **fails**
- q27-think + qf-flat: 3/5 of qf-flat's failures were never completed by q27-think - **fails**
- q27-flat + qf-think: 3/5 of q27-flat's failures were never completed by qf-think - **fails**
- q27-flat + qf-flat: 0/5 of q27-flat's failures were never completed by qf-flat - ok
- qf-think + qf-flat: 0/5 of qf-think's failures were never completed by qf-flat - ok

## Discordant tasks

**q27-think + q27-flat**

- only q27-think: -
- only q27-flat: HumanEval/124

**q27-think + qf-think**

- only q27-think: -
- only qf-think: HumanEval/154

**q27-think + qf-flat**

- only q27-think: HumanEval/140
- only qf-flat: HumanEval/151, HumanEval/154

**q27-flat + qf-think**

- only q27-flat: HumanEval/124
- only qf-think: HumanEval/154

**q27-flat + qf-flat**

- only q27-flat: HumanEval/124, HumanEval/140
- only qf-flat: HumanEval/151, HumanEval/154

**qf-think + qf-flat**

- only qf-think: HumanEval/140
- only qf-flat: HumanEval/151

---

## The reason this run says little, which is not the reason the rule gives

The rule says nothing may be claimed because one of the two style-isolated
pairs is invalid: `q27-think` truncated 3 answers, and 3 of the other side's 5
failures were among them, which is 60% of that cell against a 10% limit.

That is correct and it is not the interesting problem. **The task set is
saturated for these models.** All four score 54-55 of 60. Each has 5 or 6
failures in total and the `neither` cell is 3 to 5. A ceiling built from
`min(only_A, only_B)` has almost nothing to be built from, and a blind-spot
fraction computed over a denominator of 5 is a coin flip dressed as a
threshold.

The 10% limit was calibrated in run 3, where the stronger model had 14 to 25
failures. At 90% pass rates the same rule is far stricter in effect than in
intent — a single unattempted task is already 20% of the cell. The condition
behaved as written. It was written for a different regime.

HumanEval+ cannot discriminate between 27B-class models at n = 60. Continuing
on this task set would produce more runs like this one.

## What the numbers point at anyway, stated but not claimed

Recorded because refusing to look is its own bias, and labelled because
PREREG-4 does not permit a claim from it.

**Correlation went up, not down.** phi is 0.56 to 0.90 here against 0.47 to
0.58 for the distinct 7B models in runs 2 and 3. The one pair that holds
weights exactly constant and varies only deliberation — `q27-think` +
`q27-flat` — is the most correlated pair in the entire experiment at 0.90,
with a ceiling of 0. The same model thinking and not thinking failed on
identical tasks.

Some of that is saturation: fewer failures make agreement easier to achieve by
chance, and `expected if independent` falls to 0.4-0.5 which makes any observed
overlap look dramatic as a ratio.

**Deliberation bought no accuracy here.** 54 against 55, and 55 against 55,
while costing 61 minutes against 12 and 34 against 8. Five times the wall clock
for nothing measurable — on a saturated set, where there was little left to
buy.

Neither observation is evidence. Both are reasons to build the next
measurement differently rather than to run this one again.

