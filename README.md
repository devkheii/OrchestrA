# Democracy Harness

A local-first, auditable AI agent harness.

> Closed/verifiable tasks: seek verified consensus.
> Open tasks: surface meaningful divergence.

**Status: Phase 0.** The contract is written and the invariant tests are red. No feature module has a body yet — that is the intended state, not an unfinished one.

## Documents

| File | Role |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | **Normative.** Invariants, contracts, release gates. Read first. |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Execution order and rationale. Read only the current phase. |
| [docs/INVARIANT_TEST_MATRIX.md](docs/INVARIANT_TEST_MATRIX.md) | Every invariant mapped to an automated test ID. |
| [docs/EFFICACY_PREREG.md](docs/EFFICACY_PREREG.md) | Pre-registered decision rule for the Democracy efficacy experiment, committed before the experiment runs. |

Where the plan and the SPEC disagree, the SPEC wins.

`pnpm run matrix` verifies that every invariant maps to a test and that no code references a test ID the SPEC does not declare.

Superseded revisions are kept out of the repository on purpose: they contain defects that have since been fixed, and publishing them invites work against the wrong contract.

## Contributing

Two rules carry most of the weight:

1. **A test goes red before its module is written**, and it fails with `NotImplemented` naming the test ID it owes work to. `tests/phase0-contract.test.ts` enforces this.
2. **Every invariant maps to an automated test.** If a change touches an invariant, a required test, or a release gate, it edits `docs/SPEC.md` in the same commit.

Please read the current phase in the implementation plan before proposing a feature. Much of what the plan describes is deliberately not built yet — the orchestrator and weighted council in particular are gated behind an efficacy experiment that has not run. A PR that builds them early will be declined for that reason, not on its merits.

## Development

```sh
pnpm install
pnpm run check      # typecheck + invariant matrix + tests
pnpm run test:v01   # the v0.1 invariant suites only
```

`pnpm run check` is expected to fail on the test step during Phase 0. What must hold is that every failure is a `NotImplemented` naming the test ID it owes work to — `tests/phase0-contract.test.ts` asserts exactly that, and it passes.

### Working order

A test goes red before its module is written. `tests/phase0-contract.test.ts` is the guard against the shortcut where a stub quietly returns a plausible value and turns a suite green without implementing anything.

### Environment

- Node 20.18+ (developed on 20; `scripts/` avoids Node 22-only APIs)
- pnpm 12+
- Reference environment on Windows is **WSL2**. Native Windows runs the harness but has no sandbox adapter, so `AUTO` is unavailable and `ASK` is the ceiling — see SPEC §19.1. The `SEC-004` symlink test needs a host that can create symlinks.

## Scope of v0.1

A safe single-agent CLI harness: authenticated daemon, sessions, audit, `read`/`grep`/`glob`/`patch`/`shell`/`terminal`, path guard, permission broker, sanitized child environment, secret broker, memory, compaction, cancellation, budgets.

Not in v0.1: sandbox adapter, `AUTO` mode, council, counterexample execution, Web UI.

## License

Apache-2.0
