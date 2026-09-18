# Ceiling measurement, run 2 - results

**Run:** 2026-09-18  ·  **n = 60**  ·  HumanEval+ OriginFmt v0.1.10
**Sampling:** greedy, temperature 0, seed 20260918, 1 sample per task
**Rule:** fixed in [PREREG-2.md](PREREG-2.md) before either new model ran

## Models

| model | family | passes | | answered | truncated | no code | error |
|---|---|---|---|---|---|---|---|
| Qwen2.5-Coder-7B-Instruct Q6_K | Qwen | 46/60 | 76.7% | 60/60 | 0 | 0 | 0 |
| DeepSeek-Coder-6.7B-Instruct Q6_K | DeepSeek | 43/60 | 71.7% | 60/60 | 0 | 0 | 0 |
| Meta-Llama-3.1-8B-Instruct Q6_K | Llama | 34/60 | 56.7% | 60/60 | 0 | 0 | 0 |

## Pairs

| pair | both | only A | only B | neither | best single | oracle | **ceiling** | verdict |
|---|---|---|---|---|---|---|---|---|
| qwen + deepseek | 39 | 7 | 4 | 10 | 46 | 50 | **4** (6.7%) | inconclusive at this n |
| qwen + llama | 32 | 14 | 2 | 12 | 46 | 48 | **2** (3.3%) | below threshold |
| deepseek + llama | 31 | 12 | 3 | 14 | 43 | 46 | **3** (5.0%) | below threshold |

## Decision

> **NEGATIVE** - no pair reaches the threshold. Checkpoint B is answered negative for local councils in this hardware class. Do not build the v0.2-alpha council.

## Validity

PREREG-2 fixed two conditions in advance, both from the way run 1 failed.

**1. Every model answers every task** (at most 5 of 60 unanswered):

- qwen: answered 60/60 - ok
- deepseek: answered 60/60 - ok
- llama: answered 60/60 - ok

**2. The blind spot** - of the tasks the stronger model got wrong, how many did the other never complete (limit 10%):

- qwen + deepseek: 0/14 of qwen's failures were never completed by deepseek - ok
- qwen + llama: 0/14 of qwen's failures were never completed by llama - ok
- deepseek + llama: 0/17 of deepseek's failures were never completed by llama - ok

## Discordant tasks

**qwen + deepseek**

- only qwen: HumanEval/44, HumanEval/46, HumanEval/54, HumanEval/62, HumanEval/67, HumanEval/84, HumanEval/154
- only deepseek: HumanEval/10, HumanEval/121, HumanEval/134, HumanEval/155

**qwen + llama**

- only qwen: HumanEval/0, HumanEval/1, HumanEval/33, HumanEval/46, HumanEval/54, HumanEval/68, HumanEval/73, HumanEval/84, HumanEval/90, HumanEval/100, HumanEval/118, HumanEval/135, HumanEval/151, HumanEval/154
- only llama: HumanEval/121, HumanEval/155

**deepseek + llama**

- only deepseek: HumanEval/0, HumanEval/1, HumanEval/10, HumanEval/33, HumanEval/68, HumanEval/73, HumanEval/90, HumanEval/100, HumanEval/118, HumanEval/134, HumanEval/135, HumanEval/151
- only llama: HumanEval/44, HumanEval/62, HumanEval/67


---

## Deviation from PREREG-2, recorded

PREREG-2 named DeepSeek-Coder-6.7B-Instruct Q6_K. The file first used
(TheBloke, 2023) carries no `tokenizer.chat_template` and no
`tokenizer.ggml.pre`, so llama.cpp fell back to ChatML: the model was prompted
in a format it was not trained on and its stop token was never recognised. It
answered correctly and then hallucinated a conversation with itself until the
budget ran out, on 58 of 60 tasks. The server's own log said
`GENERATION QUALITY WILL BE DEGRADED`.

The file was replaced with QuantFactory's 2024 repack of the **same model**,
which carries both fields. The model named in the pre-registration did not
change; a defective fixture did, on a property of the file rather than of any
answer — the same grounds on which HumanEval/32 was excluded before run 1.

Scored answers from the defective file were deleted, not kept and not
compared. Had they been graded they would have read as roughly 2/60.

## What this cost, and what it bought

| pass | wall clock |
|---|---|
| Qwen2.5-Coder-7B | 33 min |
| Gemma-4-12B (run 1, invalid) | 9.1 h |
| DeepSeek-Coder-6.7B | 5 min |
| Meta-Llama-3.1-8B | 40 min |

About 10.5 GPU-hours, against the six v0.2-alpha components it says not to
build and the 650+ hours the full experiment would have cost on the run 1 pair.

## Four instrument failures, four caught by a rule written first

1. Run 1: node's fetch abandoned every generation over ~1,140 tokens at a
   constant 307s — 47 of 60. Caught by *a failed request is re-run, not scored*.
   Without it Gemma would have been reported at 13/60 as a finding.
2. Run 1: 29 of 60 truncated at the token budget, and 10 of the 14 tasks that
   could contribute to the ceiling were never attempted. Caught by the validity
   analysis, and promoted into PREREG-2 as a condition fixed in advance.
3. Run 2: a GGUF with no chat template, 58 of 60 truncated. Caught by *more
   than 5 unanswered means the model was not measured — invalid, not negative*.
4. Run 2: `/v1/models` answers 200 while weights are still loading, so the
   readiness probe could send the first task into a 503 that is recorded as a
   request error. Found while fixing 3; the probe now uses the endpoint the run
   actually uses.

Every one of them would otherwise have been reported as a plausible model
score. That is the argument for pre-registration in a sentence: not honesty
about a result, but the ability to tell a result from a malfunction.
