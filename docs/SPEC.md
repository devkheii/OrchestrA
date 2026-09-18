# Democracy Harness SPEC v2.3

**Status:** implementation contract (normative)
**Date:** 2026-09-17
**Supersedes:** `docs/archive/v2_2_SPEC.md`
**Companion:** `docs/IMPLEMENTATION_PLAN.md` (execution order, non-normative), `docs/INVARIANT_TEST_MATRIX.md`, `docs/EFFICACY_PREREG.md`

> **Precedence rule.** This file is the contract. Where the implementation plan and this SPEC disagree, this SPEC wins. Any plan change that touches an invariant, a required test, or a release gate must edit this SPEC in the same commit.

---

## 0. Changes from v2.2

**v2.3.1** restores a contract regression: memory scope isolation was invariant 13 and test T10 in the v1 plan, and was dropped silently somewhere between v1 and v2.2 — absent from the invariant list, the required tests and the release gate alike. It is back as invariant 33 / `SEC-017`. Worth noting how it was lost: each revision was reviewed for what it added, not for what it no longer said.

1. **Counterexample execution is now a governed execution path** (§8.3–8.4, invariant 31, `SEC-009..012`). v2.2 made the harness execute model-authored counterexamples but placed no sandbox, resource, mutation, network, or taint constraints on that path.
2. **`DIVERGENT` has defined runtime semantics** (§11.1, invariant 32). v2.2 defined it as a final state but not what happens to an in-flight agentic run.
3. **Task-type conservative fallback is specified as `open`** (§5).
4. **Config precedence: non-secret environment override moved back to just below CLI** (§33). v2.2 placed it below user/global config, which removes the standard injection channel for CI/container execution and contradicted v2.1.
5. **Efficacy experiment gains a fourth arm, `Single + Verifier`, and requires pre-registration** (§28). Without that arm the experiment credits Democracy for gains produced by the deterministic verifier.
6. **v0.1 is explicitly ASK-only**; `terminal` added to the v0.1 required list (§19.1, §30).
7. **Required-test list extended** to cover invariants 12, 17, 19, 20, 29, 31, 32, which had no test in v2.2 (§31).
8. v0.3 milestone split into v0.3 (orchestrator RECOMMEND) and v0.3.1 (multi-client/search/automation) (§30).
9. Identifier prefixes and the local state directory are fixed (§15, §34).

---

## 1. Product definition

A local-first AI agent harness that:

- runs as one local daemon;
- exposes CLI/TUI, Web, and later Desktop shells over the same session/API;
- supports local and remote text, vision, image, video, audio, tool, and external-agent capabilities;
- keeps memory, context, tool execution, secrets, egress, and audit under explicit policy;
- can use multiple independent models to verify closed/verifiable tasks;
- surfaces disagreement rather than forcing consensus on open-ended tasks;
- can later orchestrate model/agent placement from measured quality, latency, cost, privacy, and residency data.

The core differentiation is:

> **Closed/verifiable tasks: seek verified consensus. Open tasks: surface meaningful divergence.**

---

## 2. Non-negotiable invariants

1. Local is the default execution/privacy mode.
2. Reading a file never implies permission to send that content remotely.
3. Permission policy and OS sandbox are independent layers.
4. Every daemon endpoint requires authentication, except an optional minimal `/healthz` that exposes no session, model, file, workspace, credential, or version-sensitive data.
5. Host validation, Origin validation, and CORS deny-by-default are required for browser clients.
6. Secrets never enter model context, memory, audit logs, shell child environments, or UI responses.
7. Child processes receive a sanitized environment; provider/API secrets are not inherited.
8. Workspace path access is checked by canonical/real path, not string prefix.
9. Untrusted external content is tagged and cannot silently become system/user instruction.
10. A run tainted by untrusted external content receives stricter AUTO permissions.
11. Round 1 council members cannot see other members' answers.
12. Round 2+ members receive only their own prior answer, relevant structured objections, and new evidence — not the full peer transcript.
13. Model self-reported `confidence` is never used as a voting weight.
14. A `VALIDATED` objection can block a strong final result regardless of model weight.
15. Deterministic verifier failure overrides model consensus and supervisor preference.
16. Compaction never destroys the canonical transcript or audit trail.
17. Decision/audit records store public rationales, claims, evidence, objections, votes, verifier outputs, and tool events — not hidden chain-of-thought.
18. Unverified model agreement is never recorded as a successful operational benchmark sample.
19. Automation uses the same privacy, secret, permission, sandbox, and audit policies as interactive runs.
20. Model/council/orchestrator selection must be replayable from recorded configuration, fingerprints, context hashes, and scheduling inputs, even when bitwise model output reproduction is impossible.
21. Unsafe sandbox fallback is prohibited: when sandbox health is insufficient for AUTO, mode is degraded to ASK or READ-ONLY.
22. A council member timeout/crash cannot silently count as agreement.
23. Open-ended tasks cannot be labeled strong consensus merely because no deterministic objection was available.
24. Model switching cost is a first-class scheduling input.
25. Automatic orchestration is not enabled until enough local/operational telemetry exists.
26. Every state-changing workspace edit uses optimistic conflict detection (e.g. expected file hash) or a workspace mutation lock.
27. Cancellation cascades to model calls, tools, PTYs, subprocess trees, and council rounds and ends in a logged terminal state.
28. Session/job token, wall-time, and remote-cost budgets are enforceable before execution.
29. Config security can only become stricter at lower scopes; lower scopes cannot weaken hard global safety rules.
30. `DIVERGENT` is a legitimate final state for open tasks.
31. **Model-authored code — including counterexamples — is never executed outside a healthy sandbox, and never against the live workspace.** If sandbox health is insufficient, execution does not occur and the objection cannot reach `VALIDATED` by execution.
32. **A `DIVERGENT` or `ABSTAIN` result never silently continues an agentic run.** Interactive runs pause for user arbitration; non-interactive runs terminate without further workspace mutation or remote spend.
33. **Memory scopes do not leak.** A workspace only ever retrieves its own workspace memory; session and agent memory stay within their session and agent; global memory is shared by design and is written conservatively. One project's notes never surface while working on another.
34. **Delegation to an external agent is bounded and recorded as a suspension of guarantees.** The agent never runs against the live workspace, its output re-enters through the harness's own patch path, its logs are imported as an opaque artifact rather than presented as our event trail, and the decision record states that guarantees were suspended (§4.2).
35. **A model's reasoning is either a public rationale or it is not kept.** A model-authored summary may be stored and shown, separately from the answer and labelled as rationale. A raw reasoning channel is dropped where it arrives, and is never concatenated into the answer — once mixed in, it cannot be told apart from one (§15.1).
36. **Tool execution cannot bypass the Permission Broker.** Every tool call — whoever requested it, whatever mode the session is in — is decided by the broker before it runs, and the decision is recorded. There is no path from a model's output to an effect that skips this step.
37. **A child agent or task inherits the parent's policy, or a stricter one.** Delegation never widens permission, privacy, egress or budget. A sub-task cannot do what the task that spawned it was refused.
38. **An online benchmark score is never presented as a local measurement.** A published figure describes some other machine's build of a model; it is labelled as a prior and never shown as, or recorded as, something measured on this hardware with this quantization.
39. **Hard constraints are not scoreable.** Privacy, capability, context capacity, resource fit and budget are filters applied before scoring. No score, weight or preference can readmit a candidate that failed one.
40. **Scheduling estimates are evidence, not claims.** An ETA or score is recorded alongside the actual outcome, so a prediction can be checked against what happened rather than standing on its own.
41. **Simulated tool use is never presented as a completed action.** A model that writes tool-call syntax instead of calling a tool has not acted, and any result it goes on to report was invented. The run ends in error naming what happened, rather than the narration being scrubbed and the conclusion drawn from it left standing. A provider that cannot call tools is told so and is offered none.

42. **A weight carries its provenance.** Every weight in a council records where it came from — user override, published prior, domain profile, or accumulated operational evidence — and an undeclared weight is equal weight. A number with no stated source cannot be told apart from a guess, and a guess about which model is stronger decides the answer while looking like arithmetic.
43. **A council always has a designated supervisor.** A council that disagrees has produced no answer, and deciding what happens next cannot be delegated to another vote among the members that just failed to agree. Composing a council without a supervisor is a configuration error refused at composition time, never a runtime fallback. The supervisor remains subordinate to deterministic verification (invariant 15) and to validated counterexamples (invariant 14).

Every invariant maps to at least one automated test ID; see §32 and `docs/INVARIANT_TEST_MATRIX.md`.

---

## 3. Core runtime

One daemon owns:

- sessions;
- authenticated local API;
- context assembly;
- global/workspace/session/agent memory;
- compaction;
- provider/tool adapters;
- terminal execution;
- secret resolution;
- decision audit;
- benchmark telemetry;
- democracy engine;
- verifier engine;
- counterexample runner;
- supervisor;
- later: orchestrator.

All clients are shells:

- CLI/TUI: reference UX;
- Web: same daemon/session;
- Desktop: later thin wrapper around Web + daemon lifecycle.

---

## 4. Capability model

Capabilities are open string namespaces, not a closed enum.

Well-known examples:

```text
text.generate
text.reason
vision.analyze
embedding.generate
rerank
image.generate
image.edit
video.generate
video.edit
video.image_to_video
audio.transcribe
audio.generate
tool.call
external_agent.run
```

Providers publish capabilities and runtime metadata. Core logic must not depend on specific model names.

### 4.1 Providers and external agents are different things

A **Provider** answers a prompt. The harness keeps everything around it: context assembly, memory, the tool surface, the permission broker, the audit trail, and — later — the council. Adding a model as a Provider extends what the harness can think with, and changes nothing about what it guarantees.

An **external agent** (`external_agent.run` — Codex CLI, Claude Code, another harness) is handed the task itself. It brings its own loop, its own tools, and its own permission model.

That difference is not a matter of packaging. **An external agent run is the one place where every invariant in §2 stops applying**, and the SPEC says so plainly rather than letting the discovery happen later:

| Invariant | What delegation does to it |
|---|---|
| 7 — tool execution cannot bypass the permission broker | The agent runs its own shell and editor under its own rules |
| 8 — path access checked by real path | It uses its own filesystem access |
| 26 — conflict detection on every workspace edit | It writes without our expected-hash check |
| 16, 17 — canonical transcript and public rationale | We receive a summary, not its tool events |
| 31 — model-authored code runs only in a healthy sandbox | It executes code under its own policy |

### 4.2 The delegation boundary (normative)

Delegation is permitted, and is genuinely useful for large autonomous coding tasks. It is bounded as follows, so that what the harness promises stays true on both sides of the line:

1. **Never the live workspace.** The agent runs against an isolated copy or worktree. Invariants 8 and 26 survive at the boundary because the agent never touches the tree they protect.
2. **Results return as a diff and are re-applied by us.** The harness reviews and applies the agent's output through its own patch path, with expected-hash conflict detection and the permission broker. We do not bless writes the agent already made; we make the writes ourselves.
3. **Its audit is imported as an opaque artifact.** The agent's own logs are attached to the decision as an artifact and are never presented as the harness's own event trail. The decision record states explicitly that guarantees were suspended, for how long, and to whom.
4. **Explicit opt-in, like remote egress.** Codex CLI and Claude Code both send the entire context to a third party, so delegation passes the same gate as any other egress (§4.3) and is refused without consent.
5. **A delegated result is never a verified result on its own.** It enters the decision engine as a candidate, subject to the same verifiers as any other (invariant 15).

### 4.3 Egress follows the data, not the executable

Whether a provider or agent sends context off the machine is a property of where the data goes, never of where the process runs. A locally installed binary that relays prompts to a hosted API is remote. Classifying by process location would let an entire workspace leave the machine while the interface reported `LOCAL`.

---

## 5. Task types

The decision engine supports at least:

```text
boolean
choice
numeric
factual
code
open
```

Task type resolution priority:

1. explicit caller override;
2. deterministic detection where possible;
3. model classifier;
4. conservative fallback.

**The conservative fallback is `open`.** When the type cannot be resolved with confidence, the engine must choose the path that cannot assert false strong consensus. Implementations must not fall back to `factual`, `code`, or any comparator capable of returning `CONSENSUS_STRONG`.

Every classification is audited with:

- chosen type;
- method (`explicit` | `deterministic` | `classifier` | `fallback`);
- classifier/model identity if used;
- score/confidence metadata;
- caller override metadata.

Classification accuracy is benchmarked separately. Silent misclassification — a closed task routed to `open`, or an open task routed to a strong-consensus comparator — is a tracked metric.

---

## 6. Decision envelope

Every council answer is normalized.

```ts
interface DecisionEnvelope {
  memberId: string;
  taskType: string;
  verdict: unknown;
  claims: Claim[];
  evidence: EvidenceRef[];
  publicRationale?: string;
  confidence?: number; // informational only
}
```

A `Claim` has:

```ts
interface Claim {
  id: string;
  statement: string;
  evidence: EvidenceRef[];
}
```

---

## 7. Comparator rules

### Boolean / choice
Exact or normalized categorical comparison.

### Numeric
Canonical quantity + unit + tolerance comparison.

### Code
Primary comparison is verifier outcome, tests, compilation, lint, schema, or reproducible behavior — not prose similarity.

### Factual
Compare normalized claim sets and evidence support.

### Open
Do not force answer equivalence. Run a **divergence path**:

- identify shared conclusions;
- identify materially conflicting conclusions;
- identify unresolved assumptions/trade-offs;
- return `DIVERGENT` when meaningful disagreement remains.

An LLM comparator may be used only as a fallback and its input/output must be audited.

---

## 8. Objection model

```ts
interface Objection {
  id: string;
  reviewerId: string;
  claimId?: string;
  reason: string;
  evidence: EvidenceRef[];
  counterexample?: Counterexample;
  status:
    | "PROPOSED"
    | "VALIDATED"
    | "UNVERIFIED"
    | "INVALID";
}
```

### 8.1 Validation priority

1. **Executable counterexample**
2. Deterministic evidence check
3. Primary-source contradiction
4. Independent reviewer objection
5. Unsupported objection

Only `VALIDATED` objections are hard vetoes.

`UNVERIFIED` objections remain visible in audit and may:

- contribute to `CONSENSUS_WEAK`;
- trigger supervisor review in Critical mode;
- become part of `DIVERGENT` output for open tasks.

### 8.2 Counterexample forms

- code: generate/run a failing test case;
- numeric: provide concrete inputs and recompute;
- factual: provide a conflicting primary-source record;
- schema/API: provide an input that violates the claimed behavior.

A counterexample becomes `VALIDATED` only after the harness executes or independently verifies it.

### 8.3 Counterexample runner

Counterexample execution runs **model-authored code**. It is initiated by the decision engine, not by a user-visible tool request, so it does not inherit a tool approval. It is therefore governed by its own contract.

```text
Objection (PROPOSED, has counterexample)
  -> sandbox health check          [insufficient -> UNVERIFIED, stop]
  -> taint check                   [tainted run -> approval or disabled]
  -> materialize isolated workspace copy
  -> resource-bounded execution, network denied
  -> compare observed vs claimed behavior
  -> VALIDATED | INVALID | UNVERIFIED
  -> discard isolated copy; retain output as Artifact
```

### 8.4 Counterexample execution constraints (normative)

1. **Sandbox required.** Execution occurs only inside a healthy sandbox. If sandbox health is insufficient — including every platform or release where AUTO is unavailable — the runner does not execute, the objection is recorded `UNVERIFIED`, and the reason is audited. It never falls back to unsandboxed execution.
2. **No live workspace.** Execution targets an isolated copy or ephemeral overlay. The runner has no write access to the real workspace, and any mutation it performs is discarded after the verdict is recorded.
3. **Network denied.** The counterexample sandbox has no network egress, regardless of session egress policy.
4. **Resource bounds.** Wall-time, memory, process count, and output size limits are enforced and configurable. Exceeding any bound yields `UNVERIFIED`, never `VALIDATED`.
5. **No secrets.** The runner receives the sanitized child environment of §20; provider and tool secrets are absent.
6. **Taint propagation.** In a `TAINTED` run, counterexample execution is subject to the same downgrade as other AUTO actions: it requires approval, or is disabled by policy. A counterexample is a plausible carrier for injected payloads and is treated as untrusted content.
7. **Audited.** `counterexample.proposed`, `counterexample.executed`, and `counterexample.rejected` record the sandbox profile, resource limits, exit status, and resulting status transition.
8. **Bounded per decision.** The number of executions per decision and per round is capped by budget (§24); exhaustion yields `UNVERIFIED`, not an unbounded loop.

---

## 9. Council execution

Council concurrency is logical, not necessarily physical.

Supported execution strategies:

```text
SEQUENTIAL_LARGE
PARALLEL_SMALL
HYBRID_LOCAL
HYBRID_REMOTE
```

### SEQUENTIAL_LARGE
Default for a single GPU with large models.

### PARALLEL_SMALL
Multiple small, diverse models resident concurrently if VRAM allows.

### HYBRID_LOCAL
Some local models run concurrently/sequentially based on residency.

### HYBRID_REMOTE
Local + remote providers, subject to egress/privacy policy.

Round 1 remains blind regardless of physical execution strategy.

---

## 10. Quorum and failures

Council configuration distinguishes:

- required members;
- optional reviewers;
- retry count;
- max rounds.

Rules:

- a required member timeout/crash does not count as assent;
- after retry exhaustion, result is degraded or abstained according to policy;
- strong consensus requires the configured required quorum;
- optional reviewer failure is logged but does not automatically block.

---

## 11. Council final states

```text
VERIFIED
CONSENSUS_STRONG
CONSENSUS_WEAK
DIVERGENT
ABSTAIN
FAILED
CANCELLED
```

Closed/verifiable tasks prefer `VERIFIED` or `CONSENSUS_*`.

Open tasks may legitimately end `DIVERGENT`.

### 11.1 Runtime semantics of unresolved states

`DIVERGENT` and `ABSTAIN` are answers about the decision, not permission to keep acting. When either is reached inside an agentic run:

**Interactive session**

1. The run pauses before any further workspace mutation, tool side effect, or remote spend.
2. The client receives a `decision.unresolved` event carrying: shared conclusions, the conflicting positions attributed per member, unresolved assumptions, and what evidence would resolve the disagreement.
3. The user arbitrates — adopt one position, request another round under a raised budget, narrow the task, or cancel. Adoption is recorded in the audit trail as a user decision, attributed to the user and never to the council.
4. Work already completed is retained; partial artifacts are marked partial.

**Non-interactive session (job, headless, CI)**

1. The run terminates in the unresolved state. No further mutation, no further remote spend.
2. The job result carries the full divergence report and a non-zero exit status distinct from `FAILED`.
3. A job may opt in to a configured fallback (for example `on_divergent: abort | report | adopt_required_member`), but any `adopt_*` value must be explicit in job config and is recorded as a configuration decision, not as a consensus.

Silent continuation after an unresolved decision is prohibited (invariant 32).

---

## 12. Weighted expert mode

Default council mode is equal weight.

Optional advanced modes:

```text
equal
weighted
expert_supervisor
```

### 12.1 Where a weight may come from

Weights are **declared, not earned on the user's machine.** In order of
authority:

- explicit user override;
- a published prior, shipped with the harness or supplied in config, labelled
  with its source and the build it describes (invariant 38);
- a domain specialization profile;
- an operational profile, where one has accumulated passively from real work
  (§25.1).

A local benchmark suite is an optional refinement and is never a prerequisite.
Earlier revisions required an `established` local profile before a weight could
be trusted, which put a measurement burden on every user for a number that a
published figure already estimates well: on the reference machine a quantized
Qwen2.5-Coder-7B measured 76.7% against a published 78% on the same set. The
prior was worth about 1.5 points of error, and hours of the user's GPU.

Weights cannot come from self-reported confidence.

**An undeclared weight is equal weight.** A model with no prior, no override
and no profile enters the council at parity rather than at a guess. Guessing
would make the weighting silently depend on which models happen to be famous.

Every weight carries its provenance into the decision record, so a reader can
tell a measured number from a published one from a user's opinion (invariant
42).

### 12.2 What a weight cannot do

Weight cannot override:

- deterministic verifier failure;
- validated counterexample;
- hard privacy/security policy.

Nor can it readmit a candidate that failed a hard constraint: capability,
context capacity, privacy, resource fit and budget are filters applied before
scoring, and no weight reaches back past them (invariant 39).

---

## 13. Supervisor

**Every council has a designated supervisor** (invariant 43). A council that
disagrees has, by construction, produced no answer; something has to decide
what happens next, and leaving that to a vote among the members that just
failed to agree is how a tie becomes a coin flip.

The supervisor is the most capable model available to the session, which will
usually not be the cheapest. Assembling a council does not remove the need for
one strong judgment; it changes what that judgment is applied to, from writing
the answer to ruling on a disagreement that has already been made explicit.

Modes:

```text
on_disagreement   (default)
final
always
```

`off` is not a mode. A council with no supervisor is a configuration error
reported at composition time, not a fallback entered at runtime.

Allowed actions:

```text
ACCEPT
RETRY
ABSTAIN
```

Supervisor is not the same as Comparator:

- Comparator: are decisions compatible?
- Supervisor: what should the system do when policy, disagreement, or risk remains unresolved?

### 13.1 What the supervisor is subordinate to

Promoting the supervisor to a required role does not promote it above the
checks that exist because models are wrong confidently:

- a deterministic verifier failure overrides the supervisor's preference
  (invariant 15);
- a `VALIDATED` counterexample blocks a strong final result whatever the
  supervisor prefers and whatever weight its author carries (invariant 14);
- the supervisor's ruling is recorded as an action with its reason, not merged
  into the answer as if the council had agreed.

Expert supervisors may receive domain-specific profile advantages, but remain
subordinate to deterministic verification.

### 13.2 The open question this leaves

If the strongest model rules on every disagreement, what the weaker members add
is no longer obvious. That is exactly the quantity §28's `D - C` was written to
measure, and this section does not answer it. Recorded here so that a later
reading does not mistake a structural decision for an empirical one.

---

## 14. Memory

Scopes:

```text
global
workspace
session
agent
```

Global memory stores durable user preferences and cross-workspace rules.

Global auto-write is conservative.

Memory stores provenance:

```text
memory_id
scope
type
content
source_decision
created_at
last_used_at
```

Memory retrieval is budgeted. Full memory is never injected automatically.

---

## 15. Audit

Every meaningful answer has a `decision_id`.

Identifier prefixes are namespaced so a single CLI argument is unambiguous:

```text
ses_   session
dec_   decision
obj_   objection
ev_    evidence
art_   artifact
job_   job
wl_    workload
```

Audit stores:

- context snapshot hashes;
- model/provider identifiers;
- local model SHA256 where applicable;
- chat template/prompt hashes;
- seed/temperature/top-p where applicable;
- decision envelopes;
- objections;
- counterexample execution, including sandbox profile and resource verdict;
- evidence references;
- verifier results;
- supervisor actions;
- tool calls;
- permission decisions;
- schedule/model selection;
- predicted vs actual runtime;
- cancellation/timeout state;
- user arbitration of unresolved decisions.

Audit uses append-oriented JSONL plus SQLite indexes.

Audit must not contain hidden chain-of-thought or raw model scratchpads (invariant 17). Provider responses are filtered for reasoning-channel content before persistence.

### 15.1 Summarized rationale is not hidden chain-of-thought

Invariant 17 forbids keeping a model's hidden reasoning. It does not forbid keeping a rationale the model wrote to be read, and the two must not be conflated — §6 defines a `publicRationale` field precisely so there is somewhere for the second kind to live.

The distinction is by kind, not by wording:

- **Raw reasoning channel** — a provider's internal thinking stream. Dropped where it arrives. Not shown, not stored.
- **Summarized rationale** — a model-authored summary, which several providers return in place of raw reasoning. May be shown and may be stored, under two conditions.

The conditions are what keep the distinction meaningful:

1. **It is a separate event, never concatenated into the answer.** Once rationale is merged into answer text there is no way to tell them apart afterwards, and from that point it has to be treated as raw reasoning.
2. **Display and audit do not diverge.** Anything the user is shown is in the event log; anything in the event log can be shown. A harness that claims auditability cannot have a display path carrying content its record does not.

Where a provider supplies no rationale — the Claude Code CLI exposes none through its interface, and several APIs default to omitting it — the harness shows nothing rather than inventing something. An empty rationale is an honest answer about that provider.

---

## 16. Reproducibility

The goal is **replayable provenance**, not guaranteed bitwise deterministic output.

`dem replay --dry-run <dec_id>` verifies, without re-executing external side effects:

- provider/model fingerprint availability;
- configuration reconstruction;
- prompt/context/evidence hashes;
- tool and verifier references;
- scheduling inputs;
- permission/sandbox policy reconstruction.

It reports each item as `reconstructible` / `missing` / `changed`. It never mutates the workspace, spends remote budget, or executes tools. A separate explicit command may re-run safe evaluative portions later.

---

## 17. Context and compaction

Canonical storage and inference context are separate.

Never compress:

- security/system policy;
- code/diff fragments selected for execution;
- verifier facts;
- evidence IDs;
- decision IDs;
- file hashes;
- permission state.

May summarize/compress:

- old conversation;
- long prose documents;
- retrieved web text;
- verbose tool output.

Default v0.x approach:

- canonical transcript preserved;
- structured checkpoint summary;
- recent turns retained;
- relevant memory/evidence retrieved on demand.

LLMLingua-style extractive compression is optional later, not required for v0.1.

---

## 18. Trust / prompt injection

Every context block has a trust level:

```text
system
user
workspace
external
```

External/browser/web/fetched content is untrusted data.

A tainted run reduces AUTO privileges.

```text
normal AUTO:
  read/search/test    -> auto
  patch               -> auto/ask by policy
  counterexample exec -> auto if sandbox healthy
  network             -> ask

TAINTED AUTO:
  read/search         -> auto
  test                -> auto if sandboxed
  patch               -> ask
  counterexample exec -> ask or disabled by policy
  network             -> ask
  destructive         -> deny/ask
```

Prompt-injection resistance is benchmarked as a Democracy use-case because independent models may disagree when one is compromised by injected instructions.

---

## 19. Terminal and permissions

Modes:

```text
READ_ONLY
ASK
AUTO
FULL_ACCESS
```

AUTO is available only when sandbox health meets platform requirements.

Reference development environment on Windows: **WSL2**.

Native Windows may be supported, but if strong sandbox is unavailable/unhealthy:

```text
AUTO disabled
ASK or READ_ONLY only
```

Permission and sandbox are separate.

Tool execution pipeline:

```text
request
-> parse/segment
-> hard deny
-> permission policy
-> approval if needed
-> sandbox
-> execute
-> redact
-> artifact/audit
-> context-budgeted result
```

Shell compound commands are segmented and evaluated individually.

### 19.1 Sandbox availability by release

The sandbox adapter is **not** part of the v0.1 deliverable. Consequently:

```text
v0.1  sandbox adapter absent
      -> health probe reports UNAVAILABLE
      -> AUTO and FULL_ACCESS are not selectable
      -> ASK is both the default and the maximum
      -> counterexample execution is unavailable (8.4.1)

v0.2+ sandbox adapter present
      -> AUTO selectable where health passes
      -> counterexample execution available where health passes
```

This is a deliberate scope decision, not a defect. v0.1 ships a harness whose most permissive mode is ASK.

---

## 20. Secrets

Secret resolution order:

1. OS keychain;
2. environment reference;
3. external secret manager;
4. explicit development-only `.env` path.

Secrets are referenced, not stored in normal config.

Agent/model cannot call `secret.read`.

Provider/tool adapters receive secrets ephemerally.

`.env` rule:

- default agent file-read: values blocked/redacted;
- local process binding: allowed only through secret/environment policy;
- explicit user opt-in may expose selected values to a process, never to the model by default.

---

## 21. Local daemon authentication

All daemon endpoints require authentication — reads, event streams, and mutations alike. A read-only endpoint still exposes conversation content, file excerpts, and tool output, so it is protected identically.

Required protections:

- loopback bind by default;
- random local bearer/bootstrap secret;
- protected local token storage (`0600` on POSIX; current-user-only ACL on Windows);
- Host validation (DNS rebinding defense);
- Origin validation;
- CORS deny-by-default;
- Web UI served same-origin when practical;
- session cookie or authenticated bootstrap for browser, HttpOnly + SameSite, with CSRF protection;
- SSE/event endpoints authenticated exactly like mutation endpoints;
- tokens never placed in query strings.

Optional `/healthz` must reveal only coarse status.

---

## 22. Concurrency

- daemon assigns ordered session events;
- one active mutating run per session;
- workspace writes use mutation lock and/or expected file hash;
- SQLite uses WAL;
- multiple read-only clients may attach;
- CLI/Web input arbitration is explicit;
- conflicting edits fail safely rather than overwrite silently.

---

## 23. Cancellation / timeout

Every run owns an abort token propagated to:

- provider calls;
- council members;
- tools;
- PTY;
- subprocess tree;
- counterexample runner;
- verifier;
- supervisor.

Cancel sequence:

1. request graceful stop;
2. terminate process tree after bounded grace period;
3. close PTY;
4. discard counterexample sandboxes;
5. mark artifacts partial if needed;
6. finalize audit as `CANCELLED`.

---

## 24. Budgets

Session/job supports:

```text
max_remote_cost
max_input_tokens
max_output_tokens
max_rounds
max_wall_time
max_counterexample_executions
```

Remote execution cannot exceed budget silently.

Background jobs require explicit remote budget before using paid providers.

---

## 25. Benchmark and capability profiles

Three evidence layers:

```text
online prior          declared, free, weakest
operational evidence  passive, accumulates from real work
local benchmark       optional, never required
```

Online prior is the weakest evidence and the default source. It is labelled
with what it describes and never reported as a local measurement (invariant
38).

### 25.1 Nothing here is a suite the user runs

Earlier revisions made `established` maturity — 100 verified samples — a
precondition for trusting a weight. That is hours of a user's hardware before
the harness is useful, spent to refine a number a published figure already
estimates within a couple of points.

So:

- **Online prior** is declared. It costs nothing and is always available.
- **Operational evidence** accumulates from work the user was doing anyway, and
  only from tasks that carried an independent verification outcome or trusted
  label (invariant 18). It is never a suite; if the user runs nothing special,
  it simply stays thin.
- **A local benchmark suite is optional.** It refines a profile for someone who
  wants that. Nothing requires it, and no capability is withheld for its
  absence.

Maturity labels still describe how much evidence stands behind a number:

```text
experimental: n < 30
provisional: 30 <= n < 100
established: n >= 100
```

They qualify a claim; they no longer gate a weight. Report score with sample
size and uncertainty/confidence interval where meaningful.

### 25.2 What a prior cannot tell you

A published score describes whether a model *can* answer. It says nothing about
whether this machine can get that answer out of it.

Measured while writing this: a 12B reasoning model with respectable published
figures could not finish 29 of 60 code tasks within a 3,072-token budget on an
8GB card, spending an average of 8,129 characters of reasoning and emitting 26
characters of answer. No leaderboard reports that, because it is not a property
of the model — it is a property of this deployment.

Fit is therefore a **hard constraint checked locally, not a score** (invariant
39). The check is a single probe — does this model return an answer within the
configured budget on this machine — measured in seconds, and its result filters
the candidate before any weight is consulted. That is the only local
measurement the harness requires of anyone.

Do not build a large custom quick-suite in early releases. Start from small
licensed/adapted task sets and real verified operational telemetry.

---

## 26. Orchestrator maturity

Automatic scheduling is phased:

```text
OBSERVE
RECOMMEND
AUTO
```

### OBSERVE
User/static config chooses the model. Harness records:

- prompt tokens;
- prompt TPS;
- eval TPS;
- load/swap time;
- tool success;
- verifier pass/fail;
- actual duration;
- cost;
- residency.

### RECOMMEND
Harness suggests a model/agent but user or policy chooses.

### AUTO
Enabled only after profile maturity and efficacy criteria are satisfied.

Model scheduling pipeline:

```text
Filter
-> Score
-> Bind
-> Execute
-> Measure
```

Hard filters precede scoring:

- privacy;
- capability;
- context capacity;
- VRAM/RAM feasibility;
- budget.

Scoring may include:

- measured quality;
- capability match;
- ETA;
- current residency;
- swap cost;
- reliability;
- remote cost.

---

## 27. Residency

Model load/swap cost is first-class.

Scheduler uses hysteresis/stickiness so a small theoretical quality gain does not cause frequent model swaps.

Do not swap unless predicted total utility gain exceeds the configured threshold.

---

## 28. Efficacy gate

Do **not** build the full Orchestrator before proving Democracy value.

The minimal Democracy experiment occurs immediately after the safe single-agent baseline.

**This gate is run once, by this project, before release. It is not a feature,
it does not ship, and no user ever runs it.** It decides whether Democracy mode
is offered at all and whether it may be a default. Its cost is paid here, once,
and never charged to anyone installing the harness — which is also why it may
be expensive enough to be worth trusting (§25.1 draws the same line for
profiles).

### 28.1 Required arms

```text
A  Single
B  Single + Self-Verify     (model reviews its own answer, no external check)
C  Single + Verifier        (same deterministic verifier as D, one model)
D  2-Model Democracy + Verifier
```

**Arm C is mandatory.** On `code` and `numeric` tasks the final judgment is made by a deterministic verifier (invariant 15), so an experiment without C cannot distinguish "a second model helped" from "a verifier helped". The reportable quantity is **D − C**, not D − A.

Initial supported tasks:

```text
boolean
numeric
factual
code
```

`boolean` is supported by the comparator but is **exploratory only** in the experiment: a two-way answer space produces chance agreement that distorts the false-consensus baseline. The deciding families are `numeric`, `code`, and `factual`.

Measure:

- error rate;
- verifier-confirmed success;
- false-consensus rate;
- false-objection rate;
- abstain rate;
- latency;
- tokens;
- model swap time;
- cost.

### 28.2 Pre-registration

Before the experiment runs, `docs/EFFICACY_PREREG.md` must be committed containing:

- the frozen task set and its provenance;
- n per task family;
- the primary metric and the minimum effect size that counts as success;
- the decision rule for Checkpoint B, written before any result is seen;
- how ties and underpowered results are handled.

Changing the task set, the metric, or the threshold after seeing results invalidates the experiment; a new pre-registration and a new run are required, and both are kept in the repository.

### 28.3 Gate

If Democracy does not materially improve the target metrics over **arm C** at the pre-registered effect size, it remains experimental/optional and is not promoted as the default mode. Negative results are documented, not discarded.

---

## 29. Build-vs-borrow

Prefer mature existing tools:

```text
search/files: ripgrep
git: git CLI
browser: Playwright
pty: node-pty class library
MCP: mature SDK
sandbox: external sandbox runtime/OS isolation adapter
search web: SearXNG default; Brave/Tavily/Exa optional
media: ComfyUI adapter
compaction: checkpoint-summary pattern; optional LLMLingua later
benchmark: mature benchmark adapters where practical
```

The Harness owns:

- policy;
- privacy;
- context;
- consensus;
- audit;
- scheduling;
- integration contracts.

---

## 30. Release milestones

### v0.1 — Safe Single-Agent CLI
Required:

- authenticated daemon (all endpoints);
- CLI/TUI;
- OpenAI-compatible/llama.cpp provider;
- sessions/audit;
- read/grep/glob/patch/shell/terminal;
- path guard;
- permission broker;
- sanitized env;
- secret broker;
- basic memory;
- canonical transcript + structured compaction;
- cancellation/budgets;
- WSL2 reference dev environment.

Explicitly **not** in v0.1: sandbox adapter, AUTO mode, FULL_ACCESS, counterexample execution, council, Web.

### v0.1.1 — Providers and delegation

Pulled forward from v0.5, where the native adapters and the external-agent
adapters sat on one line together.

The reason is ordering, not appetite. The efficacy spike needs two real models
to form a council, and today there is one usable provider that cannot call
tools and no local model at all. Provider work is therefore a prerequisite for
Checkpoint B rather than a detour around it, and doing it here keeps v0.2-alpha
focused on the experiment it exists for.

Required:

- native Anthropic provider, via the official SDK, with tool calling;
- Claude Code as an external agent under the delegation boundary of §4.2
  (invariant 34), rather than as a provider with its tools stripped.

### v0.2-alpha — Minimal Democracy Efficacy Spike
Required:

- sandbox adapter + health probe (prerequisite for the counterexample runner);
- static 2-model council;
- a designated supervisor, defaulting to `on_disagreement` (invariant 43);
- declared weights with recorded provenance, defaulting to equal (invariant 42);
- a local fit probe as a hard filter before scoring (§25.2, invariant 39);
- blind Round 1;
- DecisionEnvelope;
- task override/classification;
- boolean/numeric/factual/code comparator;
- executable counterexample validation under §8.4;
- max 1 reconsideration round;
- verifier integration;
- pre-registered efficacy benchmark with arms A–D.

Explicitly excluded:

- automatic orchestrator;
- weighted council;
- large benchmark registry;
- complex task decomposition;
- open-task path.

### v0.2-beta — Democracy + Telemetry
Add:

- open-task `DIVERGENT` path and its runtime semantics (§11.1);
- quorum/partial failure;
- more robust evidence/objection paths;
- telemetry collection;
- sequential/parallel-small/hybrid execution strategies;
- supervisor modes beyond the v0.2-alpha default (`final`, `always`).

### v0.3 — Orchestrator Recommend
Add:

- capability profiles, as optional refinement over declared priors (§25.1);
- profile maturity as a label on a claim, not a gate on a weight;
- ETA prediction;
- residency metrics;
- recommendation mode.

### v0.3.1 — Multi-client, search, automation
Add:

- Web UI;
- MCP;
- web search/browser;
- automation job scheduler.

### v0.4 — Orchestrator Auto + Multimodal
Add:

- AUTO scheduling after maturity gate;
- weighted expert council;
- image/video via ComfyUI;
- vision verification;
- GPU residency manager.

### v0.5
Add:

- Desktop shell;
- ONNX browser privacy/classification/embedding/rerank experiments;
- broader remote providers and external agents beyond the two moved to v0.1.1.

### 1.0
Only when security gates, correctness gates, replay/audit gates, and efficacy gates are satisfied/documented.

---

## 31. Required tests

Test IDs are normative; see `docs/INVARIANT_TEST_MATRIX.md` for the invariant mapping.

**Security**

- `SEC-001` unauthenticated request to **any** daemon endpoint is rejected, including SSE/event streams;
- `SEC-002` external Origin and mismatched Host are rejected;
- `SEC-003` path traversal rejected;
- `SEC-004` workspace symlink escape rejected;
- `SEC-005` shell child environment contains no provider secrets;
- `SEC-006` remote provider cannot receive file content without egress approval;
- `SEC-007` TAINTED run reduces AUTO privileges;
- `SEC-008` unsafe/absent sandbox disables AUTO;
- `SEC-009` counterexample does not execute when sandbox health is insufficient;
- `SEC-010` counterexample execution cannot mutate the live workspace;
- `SEC-011` counterexample sandbox has no network egress;
- `SEC-012` counterexample exceeding resource bounds yields `UNVERIFIED`, never `VALIDATED`;
- `SEC-013` workspace/local/environment config cannot weaken a global hard safety rule;
- `SEC-014` audit records contain no reasoning-channel/scratchpad content;
- `SEC-015` secret values are redacted from tool output, audit records, model context, and UI responses;
- `SEC-016` instruction-shaped text inside file/web content does not become system or user instruction;
- `SEC-017` memory written in one workspace is not retrievable from another;
- `SEC-018` a delegated external-agent run never touches the live workspace, and its result re-enters through the harness patch path;
- `SEC-019` a raw reasoning channel is never stored or concatenated into the answer, while a summarized rationale is kept as a separate labelled event;
- `SEC-020` a tool call cannot reach execution without a Permission Broker decision, and the decision is recorded;
- `SEC-021` a child agent or task cannot hold a wider permission, privacy, egress or budget policy than its parent;
- `ORCH-007` an online benchmark score is labelled as a prior and never reported as a local measurement;
- `SEC-022` a model narrating a tool call it did not make fails the run instead of having its fabricated result reported as an answer;
- `SEC-023` a literal credential in a config file is refused, and a malformed config file fails loudly rather than being skipped.

**Decision**

- `DEC-001` Round 1 isolation;
- `DEC-002` numeric tolerance comparator;
- `DEC-003` counterexample execution turns objection `VALIDATED`;
- `DEC-004` verifier failure overrides consensus and weight;
- `DEC-005` open task can return `DIVERGENT`;
- `DEC-006` required member timeout does not count as assent;
- `DEC-007` confidence does not change vote weight;
- `DEC-008` unverified objection cannot hard-veto standard Democracy;
- `DEC-009` factual claim-set comparison;
- `DEC-010` Round 2 member receives only own prior answer, relevant validated objections, and new evidence;
- `DEC-011` unresolved task-type resolution falls back to `open`;
- `DEC-012` `DIVERGENT`/`ABSTAIN` pauses an interactive run with no further mutation or spend;
- `DEC-013` non-interactive job terminates on `DIVERGENT` with a distinct exit status;
- `DEC-014` a `VALIDATED` objection blocks a strong final result even when the objecting member carries the lower weight;
- `DEC-015` a weight records its provenance, and a member with no declared weight enters at parity;
- `DEC-016` composing a council without a supervisor is refused at composition time.

**Runtime**

- `RUN-001` cancellation kills subprocess tree/PTY and discards counterexample sandboxes;
- `RUN-002` budget prevents an additional remote call;
- `RUN-003` concurrent file edit conflict is detected via expected hash;
- `RUN-004` daemon restart preserves session and audit;
- `RUN-005` compaction leaves canonical transcript intact;
- `RUN-006` `replay --dry-run` reports reconstructibility without side effects;
- `RUN-007` scheduled job executes under the same permission/privacy/budget brokers as an interactive run.

**Orchestrator**

- `ORCH-001` OBSERVE never changes the user-selected model;
- `ORCH-002` ETA predicted/actual telemetry is recorded;
- `ORCH-003` immature profile cannot enable AUTO;
- `ORCH-004` residency hysteresis prevents low-value swap;
- `ORCH-005` hard privacy/resource filter beats score;
- `ORCH-006` unverified success never updates operational quality.

---

## 32. Invariant-to-test requirement

Every invariant in §2 must map to at least one automated test ID before implementation is considered complete.

Maintain:

```text
docs/INVARIANT_TEST_MATRIX.md
```

with columns:

```text
Invariant | Test IDs | Implementation module | Status
```

No release may contain an invariant without a test or an explicit documented exception. An invariant whose feature is not yet implemented carries status `deferred (<release>)`, never a blank.

**Removing an invariant is an explicit act.** Six invariants were lost between v2.1 and v2.2 — tool execution bypassing the permission broker, child-policy inheritance, memory scope isolation, and three about benchmark and scheduling honesty. None was argued down; the list was renumbered and they fell out. A tool that checks invariants against tests cannot catch this, because an invariant with no row has nothing to check.

So an invariant leaves this document only by being moved to the Exceptions section with a reason, and the matrix carries a provenance column naming the revision each invariant came from.

**Change of 2026-09-18 — local measurement stops being a precondition.** §12 no longer requires an `established` local benchmark profile before a weight may be used, and §25 demotes the local benchmark suite to optional. This removes a requirement, not an invariant: 18, 25, 38, 39 and 40 are unchanged and 38 does more work than before, since priors are now the ordinary source of a weight rather than the weakest fallback. Two invariants were added rather than removed — 42 (a weight carries its provenance) and 43 (a council has a supervisor) — because making weights declarative creates a new way to be wrong quietly, and promoting the supervisor to a required role creates a new way to be overruled quietly. A future revision that renumbers the list can then be diffed against its predecessor rather than read for what it gained.

---

## 33. Config precedence

Non-secret config:

```text
CLI override
> environment override
> workspace config
> user/global config
> defaults
```

Environment sits directly below CLI so that CI, container, and headless execution have a working injection channel; those environments frequently have no user/global config at all. This reverses the v2.2 ordering, which placed environment below user/global config.

Security composition is monotonic: lower scopes may tighten but not weaken hard safety constraints (invariant 29). This applies to the environment channel too — an environment variable cannot widen a global deny.

Secrets are resolved independently via Secret Broker and never flow through this chain. A config file may hold a *reference* (`env://NAME`, `secret://...`) but never a literal credential: config files get committed, so a key written there is a key in that repository's history. The loader refuses one and names the field.

A config file that cannot be read or parsed fails the load rather than being skipped. Silently falling back leaves a user believing their settings — including `maxMode` and `remoteEgress` — are in force when they are not.

Config is read from `.dem/config.json` in the workspace and in the user's home directory.

---

## 34. Minimal repository shape

```text
apps/
  daemon/
  cli/
  web/
  desktop/

packages/
  protocol/
  engine/
  adapters/

tests/
docs/
  SPEC.md
  IMPLEMENTATION_PLAN.md
  INVARIANT_TEST_MATRIX.md
  EFFICACY_PREREG.md
  archive/
```

Core engine modules:

```text
session
context
memory
compaction
policy
permissions
audit
consensus
verification
counterexample
supervisor
benchmark
orchestrator
automation_scheduler
runtime
```

Local state directory: `~/.dem/` (`app.db`, `audit/`, `artifacts/`), matching the `dem` CLI name.

Do not introduce Redis, message queues, microservices, or distributed schedulers in v0.x.

---

## 35. Project success criteria

The project succeeds if it becomes:

1. useful as a safe single-agent local coding harness even without Democracy;
2. measurably better on at least some verifiable tasks when Democracy is enabled — measured against a single model using the same verifier, not against a bare single model;
3. honest about disagreement on open tasks;
4. auditable enough to explain which models, evidence, tools, objections, and verifiers produced a result;
5. simple enough that one local daemon remains the architectural center;
6. extensible enough to add model/media/tool providers without rewriting Core;
7. capable of learning local performance characteristics without allowing unverified outputs to self-reinforce.
