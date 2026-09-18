# Ceiling measurement — results

**Run:** 2026-09-18  ·  **n = 60**  ·  HumanEval+ OriginFmt v0.1.10
**Sampling:** greedy, temperature 0, seed 20260918, 1 sample per task
**Rule:** fixed in [README.md](README.md) before any model ran

| | passes | |
|---|---|---|
| Qwen2.5-Coder-7B-Instruct Q6_K | 46/60 | 76.7% |
| Gemma-4-12B-it Q4_K_M | 31/60 | 51.7% |

## The four cells

| | gemma pass | gemma fail |
|---|---|---|
| **qwen pass** | 27 | 19 |
| **qwen fail** | 4 | 10 |

- best single model: **46/60** (76.7%)
- perfect selector (oracle): **50/60** (83.3%)
- **ceiling = 4/60 (6.7%)**
- neither model solves: 10/60 — beyond any council of this pair

## Decision

> **INCONCLUSIVE — extend to all 163 tasks before deciding**

## Is this measurement valid?

**No.** The rule above is reported as written — it is not edited after seeing a
result — but its precondition did not hold.

- **qwen**: answered 60/60; of those it answered, it passed 77%
- **gemma**: answered 31/60; of those it answered, it passed 100%

Worse than the count: of the 14 tasks **qwen** got wrong — the only
tasks where a council could gain anything — **gemma** never finished 10.
The ceiling is made of exactly that cell, so it is measured on 4 of the 14 tasks that could contribute to it.

A truncated answer is scored as a failure because that is what was fixed in
advance, and that is the right call for a model that cannot deliver inside a
budget. It is the wrong call for deciding whether a council helps, because the
model did not give a wrong answer — it gave no answer. Extending to 163 tasks
would reproduce this blindness at 2.7x the cost, not resolve it.

## Answer quality notes

| | truncated | no code | request error |
|---|---|---|---|
| qwen | 0 | 0 | 0 |
| gemma | 29 | 0 | 0 |

## Discordant tasks

Only qwen: HumanEval/1, HumanEval/20, HumanEval/33, HumanEval/36, HumanEval/40, HumanEval/44, HumanEval/46, HumanEval/59, HumanEval/68, HumanEval/78, HumanEval/84, HumanEval/102, HumanEval/114, HumanEval/117, HumanEval/118, HumanEval/147, HumanEval/151, HumanEval/153, HumanEval/154

Only gemma: HumanEval/26, HumanEval/121, HumanEval/137, HumanEval/155
