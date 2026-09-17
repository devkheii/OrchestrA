# Democracy Efficacy Pre-Registration

**Status:** template — must be completed and committed *before* the v0.2-alpha experiment runs
**Contract:** `docs/SPEC.md` §28
**Governs:** Checkpoint B in `docs/IMPLEMENTATION_PLAN.md`

This document exists so that Checkpoint B is decided by a rule written before any result was seen. The task set, metrics, thresholds, and decision rule are fixed below. The three remaining `TBD` fields are identifiers that can only exist at commit and run time; everything that could bias a judgment is already decided. Editing thresholds or the decision rule after results exist invalidates the experiment (SPEC §28.2): commit a new pre-registration and re-run.

**Pre-registration commit:** `TBD` (hash, filled at commit time)
**Experiment run date:** `TBD`
**Council model fingerprints:** `TBD` (two models from different families, each of which fits the measured 8GB VRAM budget — see §6 on correlation, and §3.3 on why "locally-resident" had to be dropped)
**Results file:** `docs/efficacy/<date>-results.md`

---

## 1. Question

Does adding a second independent model to a verified decision loop reduce wrong answers enough to justify its latency and token cost on this hardware?

The comparison that answers this is **D − C**, not D − A. Arm C already contains the deterministic verifier, which is what decides `code` and `numeric` outcomes under invariant 15. Any gain that C also shows is a verifier gain, not a Democracy gain.

---

## 2. Arms

| Arm | Configuration |
|---|---|
| A | Single model, no verification |
| B | Single model + self-review pass (no external check) |
| C | Single model + deterministic verifier, up to 1 repair round |
| D | 2-model blind council + same verifier, up to 1 reconsideration round |

Constraints that must hold across arms:

- identical task set, identical prompt scaffold, identical tool access;
- identical verifier configuration in C and D;
- arm C gets the same number of repair rounds that arm D gets reconsideration rounds, so the comparison is not confounded by retry count;
- model temperature/sampler settings fixed and recorded per arm;
- arms run in randomized order per task, not blocked, to avoid drift from thermal/residency effects.

**Equal-budget condition.** Arm D costs roughly twice the tokens and, on a single GPU with `SEQUENTIAL_LARGE`, adds model swap time. Report both:

1. **unconstrained** — each arm runs to its natural completion;
2. **equal-budget** — arm C is given the same wall-clock and token budget as D (i.e. C may use its budget for additional repair rounds or a larger model).

A Democracy win that disappears under the equal-budget condition is reported as such.

---

## 3. Task set

| Family | n | Source / provenance | Ground truth |
|---|---|---|---|
| `numeric` | 300 | script-generated arithmetic/unit/finance problems (uncontaminated by construction) + a hard subset of GSM8K | exact recomputation |
| `code` | 300 | EvalPlus (HumanEval+ / MBPP+); the `+` test suites are the grader and are never shown to the models | held-out test suite |
| `factual` | 300 | SimpleQA (short factual questions with reference sources; high base error rate leaves headroom) | primary source |
| `boolean` | 60 | derived from the `factual` pool as yes/no claims | primary source |

`boolean` is **exploratory only** and cannot decide Checkpoint B. A two-way answer space means two models agree by chance roughly half the time they are both guessing, which inflates the false-consensus baseline in a way that does not generalize to the other families.

Rules:

- the task set is frozen and hashed before the first run; the hash is recorded here;
- tasks must have ground truth that does not depend on a model's judgment;
- for `code`, the grading test suite is held out from what the models can see;
- licensing of every borrowed set is checked and recorded before the run.

**Difficulty calibration.** The pilot (§3.1) adjusts task difficulty so that **arm A's error rate lands between 20% and 40%** in each family. Outside that band the experiment cannot answer the question: above it the base model is failing for reasons a second opinion will not fix, and below it there is no headroom for any arm to demonstrate an improvement. Difficulty is adjusted by subsetting the pool, never by editing individual tasks.

**Task set hash:** `TBD`

### 3.1 Two-stage design

**Stage 1 — pilot, n = 60 per family.** Purpose: calibrate difficulty into the 20–40% band, measure the discordance rate between arms C and D, measure per-task latency per arm, and shake out malformed-envelope and verifier-coverage problems. The pilot decides nothing.

**Stage 2 — full run, n = 300 per family.** Executed against the frozen, calibrated set.

Stage 1 results may change the task pool composition. They may **not** change the metrics, thresholds, or decision rule in §4 and §5.

### 3.2 Why n = 300, and what that buys

The four arms run the same tasks, so the comparison is paired (McNemar) and only **discordant pairs** carry information.

At n = 300 with an expected discordance rate near 20%, the experiment can detect roughly an **8 percentage-point absolute** difference between arms C and D at 80% power. Detecting 5pp would require roughly 550 tasks per family; detecting 3pp, well over 1,200.

The budget consequence at n = 300: 4 arms × 300 tasks × 3 deciding families ≈ 3,600 runs. What that costs in wall-clock is now measured rather than assumed — see §3.3. On the reference machine it is on the order of **30–40 hours** of unattended execution, which is why §3.1 narrows the pilot to one family before any of it is spent.

**This is deliberately treated as a practical-significance floor, not a budget limitation.** An effect that needs more than 300 paired samples per family to become visible is, by construction, smaller than 8pp — and an 8pp-or-smaller gain does not justify a mode that costs 2–4× the latency and roughly 2× the tokens. Therefore:

> An effect not detectable at n = 300 is recorded as **not met**, not as "needs more data".

Raising n later is permitted only if the *use case* changes — for example if Democracy is being evaluated strictly as a background/batch mode where latency is free, in which case a smaller effect may be worth having and a new pre-registration is filed.

### 3.3 The measured machine, and what it forces

This document originally assumed a 16GB single GPU. The machine the experiment will actually run on has **8192 MiB** (RTX 3060 Ti). That is not a footnote: it invalidates the execution model the budget above was written against.

Measured, on that machine, through `llama.cpp`:

| model | quant | resident size | throughput | one code task |
|---|---|---|---|---|
| Qwen2.5-Coder-7B | Q6_K | ~7.5GB | 57 tok/s, fully on GPU | ~6s |
| Gemma 4 12B | Q4_K_M | ~7.5GB | 8.8 tok/s, partly on CPU | ~100s |

Two consequences the design has to absorb:

**Only one model is resident at a time.** Both fit 8GB alone; neither pair fits together. `SEQUENTIAL_LARGE` is not a mode choice here, it is the only mode. A council round is therefore load, run every task, unload, load the next — which means the experiment must be **batched by model, not by task**. Per-task model swapping would spend more time loading weights than deciding anything.

**The arms are not symmetric in cost.** A Gemma turn is roughly 17× a Qwen turn, and 583 of 726 tokens in a representative Gemma response were reasoning tokens. The §4 latency guardrails (≤4× / ≤2×) were written before this was known; they are kept as stated, but a council that includes Gemma will breach them on this hardware. That outcome is a real result about local councils on consumer GPUs, not an execution failure, and it is recorded as **not met** rather than retried on different hardware.

**Consequence for the decision rule:** none. §4 and §5 are unchanged. This section records what the numbers cost to obtain, not what counts as a pass.

---

## 4. Primary and secondary metrics

**Primary metric — false-consensus rate.** The fraction of tasks where the arm reported `VERIFIED` or `CONSENSUS_STRONG` and was wrong by ground truth. This is primary because it is the failure mode Democracy uniquely claims to fix, and because a confident wrong answer is more harmful than an abstention: the user acts on it.

**Co-primary metric — error rate.** The fraction of tasks whose final answer is wrong by ground truth. `ABSTAIN` counts as neither right nor wrong and is reported separately.

**Guardrail metric — abstain rate.** Reported alongside both primaries and subject to a hard cap in §5. Without this cap an arm can win on both primaries simply by refusing to answer more often, which is not an improvement in usefulness.

**Secondary metrics:** false-objection rate, validated-objection rate, latency p50/p95, total tokens, model swap time, remote cost, rounds used, discordance rate between C and D.

All differences are reported as **relative change with a 95% confidence interval**, because base rates differ substantially across families and an identical absolute change means different things at 10% and at 40% base error.

---

## 5. Decision rule for Checkpoint B

Written before any result is seen.

All comparisons are **D against C**. Arm A and arm B are reported for context only and never decide anything.

### 5.1 Recommended mode

Democracy is promoted to a **recommended** (not default) mode for a task family when all of the following hold in that family:

1. **Effect** — at least one of:
   - `false_consensus_rate(D)` is at least **33% lower, relative**, than arm C, 95% CI of the difference excluding zero; or
   - `error_rate(D)` is at least **25% lower, relative**, than arm C, 95% CI excluding zero.
2. **Guardrail** — `abstain_rate(D)` exceeds `abstain_rate(C)` by no more than **10 percentage points absolute**. A larger increase disqualifies the family regardless of the primaries: the arm bought its win by declining to answer.
3. **No regression** — whichever primary did not clear its threshold has not significantly worsened (its CI does not lie entirely on the worse side of zero).
4. **Latency** — median wall-clock is at most **4×** arm C, or the family is explicitly labeled background/critical-only, in which case latency is reported but not gating.

### 5.2 Default mode

Democracy becomes the **default** mode only when, in addition:

5. §5.1 holds in at least **two of the three deciding families** (`numeric`, `code`, `factual`);
6. it still holds under the **equal-budget condition** of §2;
7. median wall-clock is at most **2×** arm C. Between 2× and 4× the mode is recommended-for-critical, not default.

### 5.3 If the gate is not met

- Democracy stays behind an explicit flag, documented as unproven;
- the orchestrator, weighted council, and benchmark registry are **not** built (SPEC §28.3, plan Checkpoint B);
- the project's centre of gravity moves to what did measure well — safe single-agent execution, audit, context, and privacy.

### 5.4 Edge cases, decided in advance

**Underpowered result** — any family whose CI includes zero at n = 300 is **not met**, per §3.2. Absence of evidence is not evidence of benefit, and an effect invisible at n = 300 is below the practical-significance floor for a 2–4× latency feature.

**Tie / mixed result** — one primary improves while the other significantly worsens: **not met** for both recommended and default status.

**Guardrail breach with strong primaries** — recorded as a finding about *calibration*, not efficacy: the council is abstaining rather than deciding. It may justify tuning the abstention policy and re-running under a new pre-registration, but not promotion on this run.

**Family-level disagreement** — if `code` clears and `factual` does not, Democracy is recommended for `code` only. Per-family promotion is the expected outcome, not an exception.

---

## 6. What would make us abandon the experiment design itself

Recorded in advance to avoid rationalizing afterwards:

- **verifier coverage below ~50%** of `code`/`numeric` tasks — then arms C and D are barely distinguishable from A and the experiment measures nothing;
- **arm A error rate outside the 20–40% band** after pilot calibration (§3) — no headroom, or a base model failing for reasons a second opinion cannot address;
- **C/D discordance below ~8%** in the pilot — the two arms agree almost everywhere, so n = 300 cannot resolve anything and, more importantly, the second model is rarely changing the outcome at all;
- **malformed `DecisionEnvelope` rate high enough to force frequent retries**, confounding the latency comparison;
- **the two council models too correlated** (near-identical verdicts on >90% of tasks) — then model selection, not Democracy, is the variable that failed.

Each of these is reported as a design finding, not as a Democracy result.

---

## 7. Reporting

The results file records, per family and per arm: n, each metric with a confidence interval, the raw per-task outcome table, the task set hash, model fingerprints, sampler settings, and the harness commit.

Negative results are published in the repository with the same prominence as positive ones (SPEC §28.3).
