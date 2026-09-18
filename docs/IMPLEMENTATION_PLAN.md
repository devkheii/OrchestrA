# Democracy Harness v2.3 — Implementation & Execution Plan

**Date:** 2026-09-17
**Status:** execution order and rationale (non-normative)
**Normative contract:** `docs/SPEC.md` — where this plan and the SPEC disagree, the SPEC wins
**Supersedes:** `docs/archive/v2_2_implementation_plan.md`

---

## 0. Changes from v2.2

1. **Counterexample execution is gated behind the sandbox adapter.** It runs model-authored code, so the sandbox adapter moves from "later" into v0.2-alpha as a prerequisite, and the runner gets its own constraints (SPEC §8.4).
2. **v0.1 is ASK-only.** No sandbox adapter ships in v0.1, so AUTO and FULL_ACCESS are unselectable. This was implicit in v2.2 and is now stated.
3. **The efficacy experiment gains arm C (`Single + Verifier`)** and a committed pre-registration. Without arm C the spike credits Democracy for the verifier's work.
4. **`DIVERGENT` gets runtime semantics** — pause and arbitrate, never silently continue.
5. **Task-type fallback is `open`.**
6. **Environment config override moved back above workspace config** for CI/container use.
7. **Test IDs align with SPEC §31**, and every invariant has a row in `docs/INVARIANT_TEST_MATRIX.md`.
8. Older plan/spec revisions moved to `docs/archive/` so a new session cannot mistake one for the contract.

The development principle is unchanged:

> **Prove the differentiated idea before building automation around it.**

---

# 1. Architecture

```text
CLI / Web / Desktop
        |
        v
Authenticated Local Daemon
        |
        +-- Session / Audit / Memory / Context
        |
        +-- Permission / Secret / Sandbox / Tool Broker
        |
        +-- Decision Engine
        |      |
        |      +-- Comparator
        |      +-- Democracy
        |      +-- Counterexample Runner
        |      +-- Verifier
        |      +-- Supervisor
        |
        +-- Benchmark Telemetry
        |
        +-- Orchestrator   [later]
        |
        +-- Capability Router
                |
                +-- local LLM
                +-- remote LLM
                +-- image/video
                +-- tools/external agents
```

Core remains one daemon.

---

# 2. Phase ordering

```text
Safe Single Agent (ASK-only)
    |
    v
Sandbox adapter
    |
    v
Minimal Democracy Experiment  (arms A/B/C/D, pre-registered)
    |
    +--> D - C insufficient -> keep optional/experimental, stop here
    |
    `--> D - C positive
             |
             v
        Open-task divergence + telemetry accumulation
             |
             v
        Orchestrator RECOMMEND
             |
             v
        Orchestrator AUTO
```

Do not invert this order. In particular, do not build the orchestrator on telemetry that does not exist yet, and do not run the efficacy spike without arm C.

---

# 3. Phase 0 — Repository and test contract

## Goal

Create a minimal monorepo and lock the security/correctness contract before feature work.

## Deliverables

```text
pnpm workspace
apps/daemon
apps/cli
packages/protocol
packages/engine
packages/adapters
tests/
docs/
```

Already present:

```text
docs/SPEC.md                    normative contract
docs/IMPLEMENTATION_PLAN.md     this file
docs/INVARIANT_TEST_MATRIX.md   invariant -> test ID mapping
docs/EFFICACY_PREREG.md         template; completed before the v0.2-alpha spike
docs/archive/                   superseded revisions, not a source of truth
```

## Test contract

Test IDs are defined in SPEC §31 and grouped `SEC-*`, `DEC-*`, `RUN-*`, `ORCH-*`. Phase 0 creates the empty failing tests for the v0.1 rows of the matrix — the `SEC-*` and `RUN-*` families — and leaves later-release rows marked `deferred`.

A row moves `todo -> red -> green`. Never write a module before its test is red.

## Exit gate

- repo builds;
- unit test runner executes;
- every SPEC §2 invariant has a matrix row with a status;
- v0.1 invariant tests exist and fail for the right reason;
- no feature implementation depends on undocumented safety behavior.

---

# 4. Phase 1 — v0.1 Safe Single-Agent CLI

This phase must become useful on its own. Its most permissive mode is ASK.

## 4.1 Authenticated daemon

Implement:

```text
POST /sessions
POST /sessions/:id/messages
GET  /sessions/:id/events
POST /sessions/:id/approve
POST /sessions/:id/cancel
GET  /models
GET  /tools
GET  /memory
```

**Every endpoint requires authentication**, including the SSE event stream — it carries conversation content, file excerpts, and tool output.

Optional:

```text
GET /healthz   ->  {"status":"ok"}
```

and nothing else: no version, no session count, no workspace path.

Protections (SPEC §21):

- loopback bind by default;
- random local bearer secret, regenerated per daemon start;
- token file `0600` on POSIX, current-user ACL on Windows;
- Host validation;
- Origin validation;
- CORS deny-by-default;
- no token in query strings.

Web UI is not required yet.

## 4.2 Session/event model

Append-oriented ordered events, persisted in SQLite with WAL.

Minimum events:

```text
session.started
message.received
model.started
answer.delta
tool.requested
tool.started
tool.finished
permission.requested
permission.resolved
session.completed
session.cancelled
```

## 4.3 Fake provider

`FakeProvider` streams deterministic output. All API, CLI, and security tests run against it, so the security suite does not depend on a model being loaded.

## 4.4 OpenAI-compatible provider

`OpenAICompatibleProvider` covers llama.cpp, compatible local gateways, and optional external compatible endpoints. Do not build a provider matrix yet.

## 4.5 CLI/TUI

```text
$ dem

workspace  /project
privacy    local
mode       ask          (max available in v0.1)
model      qwen-local

> run the tests and explain failures
```

Commands:

```text
dem
dem run "..."
dem attach <ses_id>
dem cancel <ses_id>
dem log <ses_id|dec_id>
dem replay --dry-run <dec_id>
dem models
dem secret ...
```

Identifier prefixes (SPEC §15) make `dem log` unambiguous with a single argument.

## 4.6 Filesystem tools

Expose:

```text
read
grep
glob
patch
```

Implementation:

- `read`: Node fs, offset/limit;
- `grep`: ripgrep;
- `glob`: `rg --files` + matcher;
- `patch`: apply-patch style structured patching, including file creation and deletion.

No unrestricted `write` in v0.1. New files are created through `patch` so every mutation is a reviewable, auditable diff.

## 4.7 Path guard

```text
resolve -> realpath -> compare against workspace root
```

Reject traversal, symlink escape, and policy-protected secret paths. String-prefix comparison is not acceptable.

## 4.8 Terminal

```text
shell.exec
terminal.start
terminal.write
terminal.stop
```

Use a mature PTY library. Do not build a terminal emulator.

## 4.9 Permission model

```text
READ_ONLY
ASK          <- v0.1 default and maximum
AUTO         <- requires healthy sandbox; unavailable in v0.1
FULL_ACCESS  <- unavailable in v0.1
```

Shell compound commands are segmented on control operators and evaluated command by command.

The sandbox health probe ships in v0.1 and reports `UNAVAILABLE`, which is what makes the AUTO-gating testable (`SEC-008`) before the adapter exists.

## 4.10 Windows reference

Reference dev/runtime environment: **Windows 11 + WSL2**.

Native Windows may run the harness, but with no healthy sandbox it stays ASK/READ_ONLY. Never fall back to unsafe AUTO.

## 4.11 Secret Broker

Implement only:

```text
OS keychain
env:// reference
redaction (tool output, audit, context, UI)
sanitized child env
```

No cloud vaults yet. Invariant: provider secrets never appear in a child shell environment.

## 4.12 Remote egress policy

`file.read` permission and `remote.send` permission are separate. Remote providers receive only approved, sanitized context.

## 4.13 Memory v0.1

SQLite scopes `global | workspace | session | agent`, FTS5 search, conservative global auto-write. No vector DB.

```text
memory.write
memory.search
memory.delete
```

## 4.14 Compaction

```text
canonical transcript (never destroyed)
+ structured checkpoint summary
+ recent turns
```

Checkpoint fields: goal, decisions, files_changed, completed, pending, errors, constraints, evidence_refs, memory_refs.

## 4.15 Audit

SQLite index + append-only JSONL under `~/.dem/audit/`.

Record model, provider, config hash, prompt/context hash, tool calls, permission decisions, artifacts, session transitions. Filter reasoning-channel content out of provider responses before persisting (`SEC-014`).

Council-specific fields arrive in v0.2-alpha.

## 4.16 Cancellation

One abort signal per run, propagated to provider, tools, PTY, and subprocess tree. Graceful stop, bounded wait, hard kill, audit status `CANCELLED`.

## 4.17 Budgets

```text
max_input_tokens
max_output_tokens
max_wall_time
max_remote_cost
```

Enforced before execution, even before Democracy exists.

## 4.18 Config precedence

```text
CLI override > environment override > workspace config > user/global config > defaults
```

Environment sits above workspace config so containers and CI have an injection channel. Security composition stays monotonic in every channel including environment: a lower scope may tighten a rule, never widen it (`SEC-013`).

## v0.1 acceptance

A developer can `cd project && dem` and safely inspect code, search, patch, run tests, approve risky commands, keep and resume a session, cancel cleanly, and audit what happened — with ASK as the strongest mode available.

---

# 5. Phase 2 — v0.2-alpha Minimal Democracy Efficacy Spike

Deliberately small. No orchestrator, no automatic routing, no weighted council, no benchmark registry, no open-task path.

## 5.1 Sandbox adapter first

The counterexample runner executes model-authored code, so the sandbox adapter is a **prerequisite**, not a later addition.

Deliver:

- sandbox adapter behind a capability/health interface;
- health probe that distinguishes `HEALTHY` / `DEGRADED` / `UNAVAILABLE`;
- AUTO becomes selectable where health passes;
- an isolated-execution profile for the counterexample runner: no network, no live workspace, bounded wall-time/memory/processes/output.

`SEC-008` through `SEC-012` become green here.

## 5.2 Static council config

```yaml
council:
  members:
    - qwen-local
    - gemma-local
```

Manual selection only.

## 5.3 Supported tasks

```text
boolean
numeric
factual
code
```

Open tasks are not part of the first efficacy experiment.

## 5.4 DecisionEnvelope

Normalize every member output. Reject malformed envelopes and retry once; a member that cannot produce a valid envelope after retry is a failed member, not an assenting one.

## 5.5 Blind Round 1

Each member receives task, approved context, and evidence. No peer answer, regardless of physical execution strategy.

## 5.6 Comparator

Implement in this order: `boolean`, `numeric`, `code`, `factual`. Do not start with a generic LLM judge.

Task type resolution follows SPEC §5; the fallback is `open`, which in v0.2-alpha means the task is out of scope for the spike rather than silently compared as something else.

## 5.7 Counterexample-first objection validation

The highest-priority validation path, and the one governed by SPEC §8.4.

**Code** — reviewer proposes test input, expected behavior, failing assertion. The harness runs it in the isolated profile. Candidate fails -> `VALIDATED`.

**Numeric** — reviewer provides inputs and recomputation. The harness recomputes.

**Factual** — reviewer provides an evidence ref and a primary-source contradiction. The harness verifies evidence identity/content.

Hard rules, restated because they are easy to lose during implementation:

- sandbox unhealthy -> no execution -> `UNVERIFIED`, never `VALIDATED`;
- never against the live workspace;
- no network;
- resource bound exceeded -> `UNVERIFIED`;
- tainted run -> approval required or disabled;
- capped per decision by `max_counterexample_executions`.

## 5.8 Reconsideration

Maximum one round. A Round 2 member sees only: original task, its own prior answer, validated objections relevant to its own claims, new evidence. Never the full peer transcript, and never an LLM re-summary of an objection.

## 5.9 Verifier precedence

Where a verifier exists for `code`/`numeric`, a verifier failure means the result cannot be `VERIFIED` or `CONSENSUS_STRONG`, whatever the models agreed and whatever their weights.

## 5.10 Efficacy experiment

**Complete and commit `docs/EFFICACY_PREREG.md` before the first run.**

Arms:

```text
A  Single
B  Single + Self-Verify
C  Single + Verifier            <- the real baseline
D  2-Model Democracy + Verifier
```

The reported result is **D − C**. Arm C exists because the verifier, not the second model, decides `code` and `numeric` outcomes; without C the spike measures the verifier and calls it Democracy.

Report both unconstrained and equal-budget conditions. Measure error rate, verifier-confirmed success, false-consensus rate, false-objection rate, abstain rate, latency, tokens, swap time, cost.

### Gate

If D does not beat C at the pre-registered effect size:

- keep Democracy experimental and flag-gated;
- do not build the orchestrator, weighted council, or benchmark registry;
- redirect the project to what did measure well.

This is a product gate, not a marketing gate. Negative results are published.

---

# 6. Phase 3 — v0.2-beta Democracy Generalization + Telemetry

Proceed only after the Phase 2 evidence is reviewed.

## 6.1 Open task path

```text
taskType = open
```

Flow:

```text
independent proposals
-> identify shared claims
-> identify conflicting claims
-> identify assumptions/trade-offs
-> CONSENSUS_WEAK or DIVERGENT
```

Output shape:

```text
Shared conclusions
Areas of disagreement
Model A view
Model B view
What evidence would resolve the disagreement
```

> Open-task value proposition: **divergence surfacing, not forced unanimity.**

## 6.2 Runtime semantics of DIVERGENT / ABSTAIN

Implementing the output shape is not enough; the run must also stop correctly (SPEC §11.1).

**Interactive:** pause before further mutation, tool side effect, or remote spend. Emit `decision.unresolved` with the divergence report. Wait for the user to adopt a position, raise the budget for another round, narrow the task, or cancel. Record adoption as a user decision, attributed to the user.

**Non-interactive:** terminate with the divergence report and an exit status distinct from `FAILED`. A job may set `on_divergent: abort | report | adopt_required_member`, but an `adopt_*` value is a configuration decision recorded as such, never a consensus.

`DEC-012` and `DEC-013` cover this.

## 6.3 Quorum

Required members, optional reviewers, retry count, timeout. A required member timeout or crash is never assent.

## 6.4 Physical execution strategies

```text
SEQUENTIAL_LARGE
PARALLEL_SMALL
HYBRID_LOCAL
HYBRID_REMOTE
```

Benchmark separately, because this is a real fork in the design:

```text
one strong model
two large sequential models
three small parallel models
```

On the measured machine — 8192 MiB, not the 16GB this plan first assumed — the middle row is the only one available for two 7B-class models: each is about 7.5GB, so they fit alone and never together. "Three small parallel" therefore means genuinely small models, and whether three weak voices beat two strong swapped ones is exactly the question, not a detail. Measure it rather than assuming either way; `docs/EFFICACY_PREREG.md` §3.3 records the measurements this is now based on.

## 6.5 Supervisor

**Required, not optional** (SPEC §13, invariant 43). A council that disagrees
has produced no answer, and the members that just failed to agree are the worst
available tie-breaker. Composing a council without a supervisor is refused at
composition time rather than falling back at runtime.

The supervisor is the most capable model the session can reach. Default mode
`on_disagreement`. Actions `ACCEPT | RETRY | ABSTAIN`. Subordinate to
deterministic verification and validated counterexamples — promoting it to a
required role does not promote it above the checks that exist because models
are confidently wrong.

What the weaker members then add is an open question, and §28's `D - C` is what
measures it. Do not treat the structure as the answer.

## 6.6 Telemetry collection

Still no automatic scheduler. For every run collect: task type, model, model hash, prompt tokens, prompt TPS, eval TPS, load time, swap time, tool duration, verifier result, wall time, remote cost, residency.

Operational quality samples are recorded only for tasks with an independent verification outcome (`ORCH-006`). This is the data foundation for the orchestrator, and poisoning it with unverified agreement would make the scheduler self-reinforcing.

---

# 7. Phase 4 — v0.3 Orchestrator RECOMMEND

Start only when enough telemetry exists.

## 7.1 Capability profiles

Evidence layers: online prior, local benchmark, operational evidence — in increasing order of trust. Operational evidence includes verified/labeled outcomes only.

Maturity:

```text
n < 30     experimental
30-99      provisional
100+       established
```

Always show sample size and uncertainty.

## 7.2 OBSERVE first

Before recommending anything, compute and store predicted vs actual ETA and swap cost, with p50/p95 keyed by model, task type, context bucket, and hardware profile.

## 7.3 Recommendation mode

```text
Filter -> Score -> Recommend
```

No automatic binding. The UI shows the recommendation and its reasons:

```text
Recommended: Gemma
- 17% faster p50 on this task bucket
- established verifier pass rate
- already resident
```

The user may keep the current model. `ORCH-001` asserts OBSERVE/RECOMMEND never silently rebinds.

## 7.4 Hard filters

Privacy, capability, context capacity, VRAM/RAM fit, budget, provider availability — applied before scoring. A high score never rescues a candidate that fails a hard filter (`ORCH-005`).

## 7.5 Scoring

Quality, capability match, ETA, residency/swap cost, reliability, cost. Explainable terms only; the weights are recorded in the audit snapshot, not buried in code. Avoid a learned scheduler.

## 7.6 Residency hysteresis

Do not swap a resident model unless predicted utility gain exceeds `swap_min_gain`. Track unnecessary swap rate.

---

# 8. Phase 4.1 — v0.3.1 Multi-client, search, automation

Separated from the orchestrator work so neither blocks the other.

## 8.1 Web

Same daemon, same session, served same-origin where practical. No Web-only agent logic.

Pages: Sessions, Chat, Changes, Tools, Council, Audit, Settings.

Concurrent CLI/Web input follows the run-serialization rule of SPEC §22.

## 8.2 Search

Local: ripgrep + SQLite FTS5. Web default: SearXNG adapter; optional Brave/Tavily/Exa.

Keep `search`, `fetch`, and `browser` separate. Lightweight HTTP fetch first, Playwright only for JS-dependent pages.

All fetched content is `external` trust and taints the run.

## 8.3 MCP

MCP client/tool broker. MCP tools pass through privacy, permission, secret, sandbox, and audit exactly like built-in tools.

## 8.4 Automation jobs

Jobs call the same session engine under the same brokers (`RUN-007`). No separate automation security model.

```yaml
name: nightly-review
schedule: "0 2 * * *"
workspace: ./project
mode: democracy
max_wall_time: 1800
max_remote_cost: 0
on_divergent: report
```

---

# 9. Phase 5 — v0.4 Orchestrator AUTO + Weighted Expert Council

## 9.1 AUTO eligibility

Requires mature profiles, a passed efficacy gate for the task family, satisfied sandbox/privacy requirements, and sufficient local telemetry (`ORCH-003`).

## 9.2 Weighted council

Default stays `equal`. Advanced modes `weighted` and `expert_supervisor`.

Weights are declared, not earned on the user's machine (SPEC §12.1): user
override, a published prior labelled with what it describes, a domain profile,
or operational evidence that accumulated passively from real work. A local
benchmark suite is optional refinement and never a prerequisite — requiring one
charged every user hours of GPU for a number a published figure already
estimates within a couple of points.

Never self-reported confidence. An undeclared weight is equal weight, never a
guess. Every weight records its provenance (`DEC-015`). Validated counterexample
and verifier failure beat any weight (`DEC-014`).

## 9.3 Automatic council composition

Selection by domain strength, diversity, latency, residency, privacy, cost. Avoid filling a council with near-identical variants of one model when diversity is the point — and verify with §6.4's benchmark that diversity actually helps on this hardware.

---

# 10. Phase 6 — v0.4 Multimodal

ComfyUI adapter first. Capabilities `image.generate`, `image.edit`, `video.generate`, `video.image_to_video`. Artifacts stay first-class.

Residency manager decides keep / evict / load media model / restore prior model.

Generated media may be checked by independent vision models, but deterministic metadata checks are preferred where they exist.

---

# 11. Phase 7 — v0.5 Browser ONNX and external providers

`onnxruntime-web` for PII detection, secret detection, intent/task classification, embeddings, rerank, light vision classification. WASM fallback. Never a hard dependency for core operation.

Plus: Desktop shell (Electron wrapper around daemon + existing Web UI), the native OpenAI adapter, optional LiteLLM gateway, and the Codex external-agent adapter.

The native Anthropic provider and the Claude Code external agent moved to
v0.1.1 (SPEC §30). Not because they grew more interesting, but because the
efficacy spike needs two real models to form a council and there is currently
one usable provider, unable to call tools. They are a prerequisite for
Checkpoint B, not a detour around it.

---

# 12. Audit data model

```text
~/.dem/
  app.db
  audit/
  artifacts/
```

Decision log example:

```json
{"type":"decision.started","decision_id":"dec_x"}
{"type":"task.classified","task_type":"numeric","method":"explicit"}
{"type":"member.answer","member":"qwen","envelope_hash":"..."}
{"type":"member.answer","member":"gemma","envelope_hash":"..."}
{"type":"objection.proposed","id":"obj_1","counterexample":"..."}
{"type":"counterexample.executed","id":"obj_1","sandbox":"iso-v1","exit":1,"result":"fail_candidate"}
{"type":"objection.validated","id":"obj_1"}
{"type":"verification.completed","status":"pass"}
{"type":"decision.completed","status":"VERIFIED"}
```

---

# 13. Replay semantics

`dem replay --dry-run <dec_id>` repeats no side effects. It reports, per item, whether the decision can be reconstructed as a plan:

```text
model fingerprint available?
provider config reconstructible?
context/evidence hashes match?
tools/verifiers identified?
permission policy reconstructible?
scheduler inputs recorded?
```

Each answers `reconstructible` / `missing` / `changed`. A later explicit command may re-run safe evaluative portions; dry-run is inspection only.

---

# 14. Metrics

**Harness:** TTFT, prompt TPS, eval TPS, wall time, context reduction ratio, tool failure rate, cancel cleanup time.

**Democracy:** error rate, false-consensus rate, false-objection rate, validated-objection rate, abstain rate, divergence rate, round count, quality-per-second, quality-per-token, **and the D − C delta from the efficacy arms**.

**Counterexample runner:** proposal rate, execution rate, validation rate, sandbox rejection rate, resource-bound timeout rate.

**Orchestrator:** ETA MAE, ETA p95 error, recommendation acceptance, residency hit rate, model swap rate, unnecessary swap rate, quality delta vs static selection, cost delta vs static selection.

**Classifier:** task-type accuracy, silent misclassification rate, fallback-to-`open` rate, override frequency.

---

# 15. Sample and statistical policy

```text
experimental  n < 30
provisional   30 <= n < 100
established   n >= 100
```

These thresholds govern **operational capability profiles** (SPEC §25) — how much verified history a model needs before its score is trusted by the orchestrator.

The **efficacy experiment** is a different question and carries its own, much larger sample requirement: n = 300 per deciding family, in a paired design, with a two-stage pilot. See `docs/EFFICACY_PREREG.md` §3.2 for the power calculation and for why an effect invisible at n = 300 is recorded as *not met* rather than as *needs more data*.

In both cases: report raw n, effect size, and uncertainty; never promote on a tiny task set.

---

# 16. Suggested v0.1 coding order

1. repo + test contract (matrix rows red)
2. authenticated daemon
3. session/event persistence
4. fake provider
5. CLI
6. OpenAI-compatible provider
7. file/path tools
8. permission broker (ASK)
9. terminal + sanitized env
10. secret broker + redaction
11. audit + provenance
12. cancellation + budgets
13. memory
14. compaction
15. real coding-agent dogfood

Only after v0.1 is genuinely useful:

16. sandbox adapter + health probe
17. isolated counterexample execution profile
18. DecisionEnvelope
19. static 2-model council
20. comparators
21. executable counterexample validation
22. verifier
23. pre-registration commit
24. efficacy spike, arms A/B/C/D

---

# 17. Go/no-go checkpoints

## Checkpoint A — is v0.1 useful?

Can it safely replace a basic local coding-agent workflow, in ASK mode, without Democracy? If no, do not build Democracy yet — fix the base product.

## Checkpoint B — is Democracy useful?

Does the minimal 2-model design beat **arm C (single model + same verifier)** at the pre-registered effect size, on at least one task family, at acceptable latency cost?

If no:

- keep Democracy experimental and flagged;
- do not build the orchestrator, benchmark registry, or weighted council;
- refocus on safe orchestration, context, audit, and privacy if those are where the value turned out to be.

The pre-registration is committed before the run, and the decision rule is not renegotiated afterwards.

## Checkpoint C — is telemetry sufficient?

Do models have enough verified operational samples (n >= 30 per family, per SPEC §25) to support recommendations? If no, stay in OBSERVE.

## Checkpoint D — is AUTO justified?

Does RECOMMEND outperform static/manual choice often enough, with acceptable ETA error and swap behavior? If no, do not enable AUTO.

---

# 18. Definition of Done for 1.0

**Security:** every endpoint authenticated; remote egress explicit; secrets isolated; path/sandbox protections tested; tainted content lowers permissions; model-authored code never escapes the sandbox.

**Correctness:** task-type handling tested with `open` fallback; counterexample validation works under its constraints; verifier precedence works; open divergence is honest and halts the run; quorum failure is explicit.

**Audit:** decisions replayable as provenance; model/config/context/evidence hashes recorded; tool/permission/scheduling events visible; no hidden chain-of-thought stored.

**Efficacy:** Democracy value quantified against arm C; negative results documented; default recommendations match evidence.

**Orchestration:** AUTO only uses mature profiles; hard constraints beat score; ETA/residency behavior benchmarked.

**Complexity:** one daemon remains central; no mandatory distributed infrastructure; adapters do not leak provider-specific logic into Core.

---

# 19. Handoff prompt for a new coding session

Copy this together with `docs/SPEC.md`:

```text
We are implementing a local-first AI agent harness.

Read docs/SPEC.md first. It is normative.
Then read docs/IMPLEMENTATION_PLAN.md only for the current phase.
Ignore docs/archive/ entirely; those are superseded revisions.

Do not broaden scope.
Do not add Redis, queues, microservices, or a generic workflow framework.
Prefer existing mature tools: ripgrep, git, Playwright, MCP SDKs, PTY libraries, external sandbox runtimes.

Current development rules:
1.  Safe single-agent harness first; v0.1 is ASK-only, with no sandbox and no AUTO.
2.  Sandbox adapter before any execution of model-authored code.
3.  Minimal Democracy efficacy spike second, with arms A/B/C/D and a committed pre-registration.
4.  The result that matters is D - C, not D - A.
5.  Telemetry before automatic orchestration; RECOMMEND before AUTO.
6.  Closed/verifiable tasks seek verified consensus; open tasks surface divergence.
7.  DIVERGENT and ABSTAIN pause the run; they never silently continue it.
8.  Executable counterexamples are the strongest objection path, and run only in a healthy
    sandbox, off the live workspace, with no network and bounded resources.
9.  Every daemon endpoint requires auth, including event streams.
10. Secrets never enter model context, audit, or child environments.
11. Every invariant maps to an automated test in docs/INVARIANT_TEST_MATRIX.md.

Before implementing, state: the exact phase, the files to touch, and the test IDs that will
prove the change. Write the test red before the module.
```

---

# 20. Final design principle

The project should not become "a framework that can do everything."

Its identity is:

> **A small, auditable, local-first agent runtime that first proves whether multiple independent models improve verifiable decisions, then uses measured local evidence to orchestrate the right models, tools, and runtimes efficiently.**
