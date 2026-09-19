# Ceiling measurement, run 3 - results

**Run:** 2026-09-19  ·  **n = 60**  ·  HumanEval+ OriginFmt v0.1.10
**Sampling:** greedy, temperature 0, seed 20260918, 1 sample per task
**Server:** `-ngl 999 -fa on -ctk q8_0 -ctv q8_0`, identical for every model
**Rule:** fixed in [PREREG-3.md](PREREG-3.md) before any model answered under these settings

## Models

| model | family | passes | | answered | truncated | no code | error | budget | wall clock |
|---|---|---|---|---|---|---|---|---|---|
| Qwen2.5-Coder-7B-Instruct Q6_K | Qwen | 46/60 | 76.7% | 60/60 | 0 | 0 | 0 | 1024 | 3 min |
| DeepSeek-Coder-6.7B-Instruct Q6_K | DeepSeek | 42/60 | 70.0% | 60/60 | 0 | 0 | 0 | 1024 | 1 min |
| Meta-Llama-3.1-8B-Instruct Q6_K | Llama | 35/60 | 58.3% | 60/60 | 0 | 0 | 0 | 1024 | 3 min |
| Gemma-4-12B-it Q4_K_M | Gemma | 27/60 | 45.0% | 27/60 | 33 | 0 | 0 | 8192 | 277 min |

## Pairs

| pair | both | only A | only B | neither | best | oracle | **ceiling** | verdict |
|---|---|---|---|---|---|---|---|---|
| qwen + deepseek | 39 | 7 | 3 | 11 | 46 | 49 | **3** (5.0%) | below threshold |
| qwen + llama | 33 | 13 | 2 | 12 | 46 | 48 | **2** (3.3%) | below threshold |
| qwen + gemma | 24 | 22 | 3 | 11 | 46 | 49 | **3** (5.0%) | INVALID |
| deepseek + llama | 32 | 10 | 3 | 15 | 42 | 45 | **3** (5.0%) | below threshold |
| deepseek + gemma | 23 | 19 | 4 | 14 | 42 | 46 | **4** (6.7%) | INVALID |
| llama + gemma | 21 | 14 | 6 | 19 | 35 | 41 | **6** (10.0%) | INVALID |

## Failure correlation

The primary question of this run: do these models fail on the same tasks more than chance,
and would independence have changed the verdict?

| pair | both fail | expected if independent | ratio | **phi** [95%] | ceiling | ceiling if independent |
|---|---|---|---|---|---|---|
| qwen + deepseek | 11 | 4.2 | 2.62x | **0.58** [0.39, 0.73] | 3 | 9.8 |
| qwen + llama | 12 | 5.8 | 2.06x | **0.49** [0.27, 0.66] | 2 | 8.2 |
| qwen + gemma | 11 | 7.7 | 1.43x | **0.26** [0.01, 0.48] | 3 | 6.3 |
| deepseek + llama | 15 | 7.5 | 2.00x | **0.55** [0.35, 0.71] | 3 | 10.5 |
| deepseek + gemma | 14 | 9.9 | 1.41x | **0.30** [0.05, 0.51] | 4 | 8.1 |
| llama + gemma | 19 | 13.8 | 1.38x | **0.36** [0.11, 0.56] | 6 | 11.3 |

At n = 60 phi is a width, not an estimate. PREREG-3 set the thresholds far apart for that reason.

## Decision

> **NEGATIVE** - no pair reaches the threshold. Checkpoint B stays answered negative for local councils in this hardware class.

## What may be claimed

> **No generalization is claimed, because the model that would have tested it was not measured.**

PREREG-3's first branch requires every pair -- explicitly including every pair involving the reasoning model -- to clear phi 0.35. gemma answered fewer than 55 of 60 tasks, so its pairs were not measured and cannot clear anything.

What run 3 does establish: the 3 valid pairs reproduce run 2 under a single server configuration, with ceilings of 3, 2, 3 and phi of 0.58, 0.49, 0.55. The objection that run 2 measured a configuration difference rather than a model difference is answered. The objection that it measured one kind of model is not.

**The invalid pairs show lower phi, and that is what missing data looks like, not what decorrelation looks like.** A truncated answer is scored as a failure, and those failures land on tasks unrelated to where the other model fails, which mechanically pushes phi down and the ceiling up. The blind-spot figures below say the same thing from the other side: most of the stronger model's failures were never attempted. Those numbers are not evidence of anything and are reported only so that nobody recovers them later as if they were.

## Validity

**1. Every model answers every task** (at most 5 of 60 unanswered):

- qwen: answered 60/60 - ok
- deepseek: answered 60/60 - ok
- llama: answered 60/60 - ok
- gemma: answered 27/60 - **fails**

**2. The blind spot** - of the tasks the stronger model got wrong, how many did the other never complete (limit 10%):

- qwen + deepseek: 0/14 of qwen's failures were never completed by deepseek - ok
- qwen + llama: 0/14 of qwen's failures were never completed by llama - ok
- qwen + gemma: 11/14 of qwen's failures were never completed by gemma - **fails**
- deepseek + llama: 0/18 of deepseek's failures were never completed by llama - ok
- deepseek + gemma: 14/18 of deepseek's failures were never completed by gemma - **fails**
- llama + gemma: 19/25 of llama's failures were never completed by gemma - **fails**

## Discordant tasks

**qwen + deepseek**

- only qwen: HumanEval/44, HumanEval/46, HumanEval/54, HumanEval/62, HumanEval/67, HumanEval/84, HumanEval/154
- only deepseek: HumanEval/10, HumanEval/121, HumanEval/155

**qwen + llama**

- only qwen: HumanEval/0, HumanEval/1, HumanEval/33, HumanEval/46, HumanEval/54, HumanEval/68, HumanEval/73, HumanEval/84, HumanEval/100, HumanEval/118, HumanEval/135, HumanEval/151, HumanEval/154
- only llama: HumanEval/121, HumanEval/155

**qwen + gemma**

- only qwen: HumanEval/1, HumanEval/20, HumanEval/33, HumanEval/36, HumanEval/44, HumanEval/46, HumanEval/59, HumanEval/67, HumanEval/68, HumanEval/70, HumanEval/84, HumanEval/88, HumanEval/100, HumanEval/102, HumanEval/114, HumanEval/117, HumanEval/118, HumanEval/147, HumanEval/151, HumanEval/153, HumanEval/154, HumanEval/156
- only gemma: HumanEval/26, HumanEval/137, HumanEval/155

**deepseek + llama**

- only deepseek: HumanEval/0, HumanEval/1, HumanEval/10, HumanEval/33, HumanEval/68, HumanEval/73, HumanEval/100, HumanEval/118, HumanEval/135, HumanEval/151
- only llama: HumanEval/44, HumanEval/62, HumanEval/67

**deepseek + gemma**

- only deepseek: HumanEval/1, HumanEval/10, HumanEval/20, HumanEval/33, HumanEval/36, HumanEval/59, HumanEval/68, HumanEval/70, HumanEval/88, HumanEval/100, HumanEval/102, HumanEval/114, HumanEval/117, HumanEval/118, HumanEval/121, HumanEval/147, HumanEval/151, HumanEval/153, HumanEval/156
- only gemma: HumanEval/26, HumanEval/54, HumanEval/62, HumanEval/137

**llama + gemma**

- only llama: HumanEval/20, HumanEval/36, HumanEval/44, HumanEval/59, HumanEval/67, HumanEval/70, HumanEval/88, HumanEval/102, HumanEval/114, HumanEval/117, HumanEval/121, HumanEval/147, HumanEval/153, HumanEval/156
- only gemma: HumanEval/0, HumanEval/26, HumanEval/54, HumanEval/73, HumanEval/135, HumanEval/137
