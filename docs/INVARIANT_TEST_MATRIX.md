# Invariant / Test Matrix

**Status:** draft, created at Phase 0
**Contract:** `docs/SPEC.md` §2 (invariants), §31 (test IDs), §32 (this requirement)

Every invariant in SPEC §2 maps to at least one automated test ID. No release ships an invariant with a blank status: an unimplemented feature carries `deferred (<release>)` and a one-line reason.

**Status values**

| Value | Meaning |
|---|---|
| `todo` | in scope for the named release, test not yet written |
| `red` | test written and failing (expected state before implementation) |
| `green` | test written and passing |
| `deferred (<rel>)` | feature not in scope until that release; test written no earlier |
| `exception` | deliberately untested; requires a written justification below |

**Rule:** tests are written before the module. A row moves `todo -> red -> green`, never straight to `green`.

---

## Security and privacy

| # | Invariant (abbreviated) | Test IDs | Module | Status |
|---|---|---|---|---|
| 1 | Local is the default execution/privacy mode | `SEC-006` | policy, adapters | todo (v0.1) |
| 2 | File read never implies remote egress | `SEC-006` | policy, permissions | todo (v0.1) |
| 3 | Permission and sandbox are independent layers | `SEC-008`, `SEC-010` | permissions, runtime | deferred (v0.2-alpha) — sandbox adapter lands with the counterexample runner |
| 4 | Every endpoint authenticated (except minimal `/healthz`) | `SEC-001` | daemon | todo (v0.1) |
| 5 | Host/Origin validation, CORS deny-by-default | `SEC-002` | daemon | todo (v0.1) |
| 6 | Secrets never in context/memory/audit/child env/UI | `SEC-005`, `SEC-015` | secrets, audit, context | todo (v0.1) |
| 7 | Child processes get a sanitized environment | `SEC-005` | runtime, permissions | todo (v0.1) |
| 8 | Path access checked by canonical/real path | `SEC-003`, `SEC-004` | policy, tools | todo (v0.1) |
| 9 | Untrusted content cannot become instruction | `SEC-016` | context | todo (v0.1) |
| 10 | Tainted run receives stricter AUTO | `SEC-007` | context, permissions | deferred (v0.2-alpha) — AUTO does not exist in v0.1 (SPEC §19.1) |
| 21 | No unsafe sandbox fallback | `SEC-008` | permissions, runtime | todo (v0.1) — v0.1 asserts AUTO is unselectable with no sandbox |
| 29 | Security config composes monotonically | `SEC-013` | policy | todo (v0.1) |
| 31 | Model-authored code runs only in a healthy sandbox, never against the live workspace | `SEC-009`, `SEC-010`, `SEC-011`, `SEC-012` | counterexample, runtime | deferred (v0.2-alpha) |

Note on #21: the invariant is testable in v0.1 even though the sandbox adapter is absent. The v0.1 assertion is the negative one — with no sandbox present, AUTO and FULL_ACCESS must be unselectable. The positive case (healthy sandbox enables AUTO) is added in v0.2-alpha.

---

## Decision correctness

| # | Invariant (abbreviated) | Test IDs | Module | Status |
|---|---|---|---|---|
| 11 | Round 1 members cannot see peer answers | `DEC-001` | consensus | deferred (v0.2-alpha) |
| 12 | Round 2+ receives own answer + relevant objections + new evidence only | `DEC-010` | consensus | deferred (v0.2-alpha) |
| 13 | `confidence` is never a voting weight | `DEC-007` | consensus | deferred (v0.2-alpha) |
| 14 | `VALIDATED` objection blocks strong final regardless of weight | `DEC-014`, `DEC-003` | consensus | deferred (v0.2-alpha) |
| 15 | Deterministic verifier failure overrides consensus and supervisor | `DEC-004` | verification, consensus | deferred (v0.2-alpha) |
| 22 | Member timeout/crash is never assent | `DEC-006` | consensus | deferred (v0.2-beta) — quorum policy |
| 23 | Open tasks cannot be labeled strong consensus by absence of objection | `DEC-005`, `DEC-011` | consensus | deferred (v0.2-beta) — open path |
| 30 | `DIVERGENT` is a legitimate final state | `DEC-005` | consensus | deferred (v0.2-beta) |
| 32 | `DIVERGENT`/`ABSTAIN` never silently continues a run | `DEC-012`, `DEC-013` | session, consensus, automation_scheduler | deferred (v0.2-beta) |

Additional decision tests not tied to a single invariant but required by SPEC §31: `DEC-002` (numeric tolerance), `DEC-008` (unverified objection is not a veto), `DEC-009` (factual claim-set comparison).

---

## Runtime, state, audit

| # | Invariant (abbreviated) | Test IDs | Module | Status |
|---|---|---|---|---|
| 16 | Compaction never destroys canonical transcript or audit | `RUN-005` | compaction, audit | todo (v0.1) |
| 17 | Audit stores public rationale, never hidden chain-of-thought | `SEC-014` | audit, adapters | todo (v0.1) |
| 19 | Automation uses the same policies as interactive runs | `RUN-007` | automation_scheduler | deferred (v0.3.1) |
| 20 | Selection is replayable from recorded provenance | `RUN-006` | audit, runtime | todo (v0.1) — provenance recorded in v0.1; council/scheduler fields added per release |
| 26 | Workspace edits use conflict detection or a mutation lock | `RUN-003` | session, tools | todo (v0.1) |
| 27 | Cancellation cascades and ends in a logged terminal state | `RUN-001` | session, runtime | todo (v0.1) |
| 28 | Budgets are enforceable before execution | `RUN-002` | policy, runtime | todo (v0.1) |

Additional runtime test required by SPEC §31: `RUN-004` (daemon restart preserves session and audit).

Note on #20: `RUN-006` is written in v0.1 against the provenance fields that exist then (model fingerprint, config, context/evidence hashes, tool refs, permission policy). It is extended, not replaced, when council fields arrive in v0.2-alpha and scheduler inputs in v0.3.

---

## Benchmark and orchestration

| # | Invariant (abbreviated) | Test IDs | Module | Status |
|---|---|---|---|---|
| 18 | Unverified agreement is never a successful operational sample | `ORCH-006` | benchmark | deferred (v0.2-beta) — telemetry collection |
| 24 | Model switching cost is a first-class scheduling input | `ORCH-004` | orchestrator, runtime | deferred (v0.3) |
| 25 | AUTO orchestration requires sufficient telemetry | `ORCH-003` | orchestrator, benchmark | deferred (v0.4) |

Additional orchestrator tests required by SPEC §31: `ORCH-001` (OBSERVE does not bind), `ORCH-002` (ETA predicted/actual recorded), `ORCH-005` (hard filter beats score).

---

## Coverage summary

| Release | Invariants that must be `green` |
|---|---|
| v0.1 | 1, 2, 4, 5, 6, 7, 8, 9, 16, 17, 20, 21, 26, 27, 28, 29 |
| v0.2-alpha | + 3, 10, 11, 12, 13, 14, 15, 31 |
| v0.2-beta | + 18, 22, 23, 30, 32 |
| v0.3 | + 24 |
| v0.3.1 | + 19 |
| v0.4 | + 25 |
| 1.0 | all 32, plus the efficacy gate of SPEC §28 |

---

## Exceptions

None recorded. Any future entry here requires: the invariant number, why an automated test is impractical, what manual or structural control replaces it, and who accepted the risk.
