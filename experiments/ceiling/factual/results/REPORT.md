# Factual cross-validation — results

**Run:** 2026-09-20  ·  **n = 294**  ·  TriviaQA rc.nocontext, seed 20260920
**Sampling:** greedy, temperature 0, seed 20260918, 1 sample per question
**Grading:** the dataset's own alias lists. No model grades anything.
**Rule:** fixed in [PREREG-F1.md](PREREG-F1.md) before any model answered

## Models

| model | family | correct | answered | refused | missing |
|---|---|---|---|---|---|
| Qwen3.8-27B (no thinking) | Qwen3.8 | 192/294 (65.3%) | 283 | 11 | 0 |
| Qwen3.8-Flash-Next (no thinking) | Qwen3.8 | 245/294 (83.3%) | 292 | 2 | 0 |
| Meta-Llama-3.1-8B-Instruct | Llama | 203/294 (69.0%) | 293 | 1 | 0 |

## When two models agree, is the agreement right?

| pair | cross-lineage | agree right | **agree wrong** | disagree | one refused | **false consensus** |
|---|---|---|---|---|---|---|
| q27-flat + qf-flat | no | 183 | **11** | 88 | 12 | **5.7%** |
| q27-flat + llama | **yes** | 156 | **17** | 110 | 11 | **9.8%** |
| qf-flat + llama | **yes** | 184 | **14** | 93 | 3 | **7.1%** |

False consensus is `agree wrong / (agree wrong + agree right)`: given that they agreed, how often
that agreement was wrong. It is the number a user would be trusting.

## If the council abstains whenever its members disagree

| pair | coverage | accuracy when it answers | best single model | errors removed |
|---|---|---|---|---|
| q27-flat + qf-flat | 66.0% | 94.3% | 83.3% | 77.6% of 49 |
| q27-flat + llama | 58.8% | 90.2% | 69.0% | 81.3% of 91 |
| qf-flat + llama | 67.3% | 92.9% | 83.3% | 71.4% of 49 |

## Accuracy ceiling and failure correlation, for continuity with runs 1-4

| pair | both | only A | only B | neither | ceiling | phi |
|---|---|---|---|---|---|---|
| q27-flat + qf-flat | 186 | 6 | 53 | 37 | **6** (2.0%) | 0.49 |
| q27-flat + llama | 164 | 28 | 35 | 56 | **28** (9.5%) | 0.48 |
| qf-flat + llama | 194 | 51 | 8 | 38 | **8** (2.7%) | 0.49 |

## A — does agreement mean anything?

> **Agreement is informative.** When these models agree, they are wrong 9.8% and 7.1% of the time. A council can serve as a confidence signal where no verifier exists, which is a real niche for this harness — not the corrector it was designed as, but a detector worth having.

## B — is abstaining on disagreement worth it?

> **The detector is not worth building at this cost.** Abstaining removes 81.3% and 71.4% of errors at 58.8% and 67.3% coverage, short of the threshold fixed in PREREG-F1 (one third of errors at 70% coverage).

## Validity

**1. Every model answered** (at most 14 of 294 missing):

- q27-flat: 0 missing — ok
- qf-flat: 0 missing — ok
- llama: 0 missing — ok

**2. The blind spot:**

- q27-flat + qf-flat: 0.0% of the stronger model's errors were never attempted by the other — ok
- q27-flat + llama: 0.0% of the stronger model's errors were never attempted by the other — ok
- qf-flat + llama: 0.0% of the stronger model's errors were never attempted by the other — ok

**5. Refusals are not answers.** Counted above and excluded from the agreement cells, so two
models declining is never scored as consensus.

## A sample of false consensus

The cases that matter: both models said the same thing, confidently, and it was wrong.

- **The 66 mile long Shropshire Union Canal links the city of Wolverhampton to which town situated in Cheshire?**
  - both said: `Nantwich`  ·  correct: `ELLESMERE PORT`
- **Which famous London railway station is located on a bridge over the River Thames?**
  - both said: `Waterloo`  ·  correct: `Blackfriars`
- **Which rugby league team is known as the Rhinos?**
  - both said: `Leeds Rhinos`  ·  correct: `LEEDS`
- **Which is the largest in area - The Sahara Desert or Australia?**
  - both said: `Australia`  ·  correct: `The Sahara Desert`
- **What river flows through the Grand Canyon in the USA?**
  - both said: `Colorado River`  ·  correct: `Colorado`
- **Pearmain is a variety of what?**
  - both said: `Pear`  ·  correct: `Apple`
- **"Geography - which ""Strait"" in the Mediterranean lies between Sicily and mainland Italy ?"**
  - both said: `Strait of Messina`  ·  correct: `MESSINA`
- **Who were the Greek equivalents of the Norns of Norse mythology?**
  - both said: `Moirai`  ·  correct: `The Fates`
- **What type of oil is traditionally used to protect cricket bats ?**
  - both said: `Linseed oil`  ·  correct: `LINSEED`
- **Which cartoon character created by Al Capp lives in Dog Patch?**
  - both said: `Li'l Abner`  ·  correct: `L'ABNER`
- **Yorkshireman William Strickland is believed to have brought the first what to Britain from North America in 1526?**
  - both said: `Tobacco`  ·  correct: `Turkey`
- **What is the imperial distance of a marathon race?**
  - both said: `26.2 miles`  ·  correct: `26 miles, 385 yards`

---

## False consensus is an upper bound

Three of the remaining cases above are the grader's fault, not the models':

| both said | dataset wants |
|---|---|
| `Leeds Rhinos` | `LEEDS` |
| `Colorado River` | `Colorado` |
| `Strait of Messina` | `MESSINA` |

The models are right. TriviaQA's alias list does not carry those forms, and
PREREG-F1 fixed exact match against the alias list before any answer existed.
Relaxing it to substring matching now would move numbers in the direction this
run would prefer, which is the one edit a pre-registration exists to prevent.

So the rule stands and the reported rate is a **ceiling on false consensus, not
an estimate of it**. The true rate is lower, which makes verdict A stronger
rather than weaker — and leaves it the only direction the correction could have
gone.

Coverage is unaffected: those questions are agreed either way, so verdict B does
not move.

## An earlier grading defect, and what it nearly cost

The first grading pass reported 11.0% and 8.7%, which straddles the 10%
threshold A turns on.

The cause was in the implementation, not the rule. PREREG-F1 says "punctuation
stripped"; the code deliberately preserved apostrophes, so a model answering
`Valéry Giscard d'Estaing` never matched the dataset's `valery giscard
destaing` and a correct answer was scored as false consensus. Accents were not
folded either, for the same class of reason.

The fix makes the code do what the document already said. It was found by
printing the false-consensus cases and reading them, which is the one thing
that catches a grader — every aggregate looked entirely plausible.

