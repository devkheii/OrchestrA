# Democracy Harness

A local-first, auditable AI agent harness. The repository is `OrchestrA`; the harness is Democracy Harness and its command is `dem`.

> Closed/verifiable tasks: seek verified consensus.
> Open tasks: surface meaningful divergence.

**Status: v0.1 feature-complete.** All seventeen v0.1 invariants are green: authenticated daemon, path guard, permission broker, secret isolation, egress policy, memory scoping, audit and replay, cancellation, budgets, conflict detection, compaction.

## Install

```sh
pnpm install
pnpm run install:cli   # builds, then puts `dem` on your PATH
```

## First minute

```sh
dem setup
```

It looks for what is already on this machine — a running Ollama, LM Studio or
llama.cpp server, and `.gguf` files in the usual places — lists what it found,
and writes `.dem/config.json` for whichever you pick. It takes under a second
and it does not configure anything without asking.

```
dem setup

looking for models on this machine…

Found 5:

  1  Ollama — qwen-coder:latest
      http://127.0.0.1:11434  ·  already running  ·  qwen-coder:latest
  2  gemma-4-12b-it-Q4_K_M.gguf
      6.6GB  ·  E:\models\gemma-4-12b-it-Q4_K_M.gguf  ·  dem will serve it with llama.cpp
  ...
  6  something else — type an endpoint myself

which? [1-6]
```

Nothing found? It says so and tells you the three ways to give it a model,
rather than starting anyway.

**An unconfigured `dem` refuses to run.** It used to answer with a fake
provider that echoed your question back, which looks like it works and is
worse than an error. `--provider fake` still gets you that deterministic
provider when you actually want one.

Then:

```sh
dem models           # what it can reach, and whether it leaves this machine
dem run "..."        # one question
dem                  # a session
```

## Use

```sh
dem                      # interactive session — ask, follow up, keep the context
dem run "..."            # one prompt, print the answer, exit
dem log ses_...          # what actually happened in a session
dem models               # what this daemon can reach, and whether it is LOCAL
dem setup                # find a model and write the config
dem auth add <name>      # store a credential for a remote provider
```

Inside a session, the commands print on entry rather than hiding behind
`/help`:

```
/model [name]                          see or change which model this provider is asked for
/provider [name | add | remove <name>] choose, add or remove a provider
/session                               the current session id
/new                                   a fresh session
/help                                  this list
/exit                                  leave
```

`/provider add` asks for a name, an endpoint and a key, stores the key in the
credential store and writes only `secret://<name>` into config. `/model` with
no argument asks the endpoint what it serves and marks the one in use.

They write to the same `.dem/config.json` that `dem setup` and your editor
write — there is no session-only state — and a change takes effect on the next
run, which the session tells you rather than pretending otherwise.

An interactive session holds one session id for the whole conversation, so a
follow-up builds on what came before rather than starting cold. `/new` discards
it, `/session` prints the id, `/exit` leaves.

When a tool needs approval you are asked, with the exact command in view:

```
shell  npm test
requires approval in ASK mode
allow? [y]es / [a]lways this session / [N]o
```

`a` remembers that tool with that exact subject for the rest of the session —
saying yes to `npm test` does not say yes to `rm -rf build`. Everything else is
asked again. The default is no, including when stdin is a pipe: something that
cannot consent is not treated as consenting.

`dem log` reads the same append-only event log the agent loop rebuilds the
conversation from each round. It is the record, not a rendering of one.

## Configure

Write the model down once, in `.dem/config.json` — in the workspace, or in your home directory for a default across all of them:

```json
{
  "baseUrl": "http://127.0.0.1:8099",
  "model": "qwen2.5-coder-7b",
  "modelPath": "C:/models/qwen2.5-coder-7b-q6_k.gguf"
}
```

Set `modelPath` and the harness starts `llama serve` itself when nothing is listening on that port, and stops only what it started — a server you were already running is left alone, because loading a model takes long enough that killing someone else's is a real cost. Without `modelPath` you run the server yourself and the harness just attaches.

The first time the harness serves a model it has not seen configured this way,
it asks the model five trivial questions with known answers. This takes
seconds, is cached, and re-runs only when the model file, quantization or
server flags change.

It exists because of a measured failure. Quantizing the KV cache to `q4_0` to
fit an 8GB card took a model from 46/60 on HumanEval+ to **0/60** — answering a
bare `from` inside a code fence in 1.4 seconds — while every published figure
still said 78%. `q8_0` cost nothing at all and ran eleven times faster.

So a check that only asks whether an answer came back would have passed it.
This one asks whether the answer is right, and refuses to run a configuration
that cannot add 17 and 25. `--skip-smoke-test` overrides it.

It catches configurations that are **broken**, not ones that are merely worse.
Nothing here will notice that your setup quietly costs seven points of
accuracy, because noticing would mean making every user run a benchmark. That
trade is deliberate (SPEC §25.3).

Precedence is `CLI > environment > workspace > user > defaults` (SPEC §33). Security settings do not follow it: they compose monotonically, so a narrower scope can only tighten. A malformed config file is refused rather than skipped — believing your `maxMode` is in force when it silently is not is the opposite of what the setting was for.

**Credentials never go in config as literals.** Config files get committed, so the loader refuses anything that looks like a real key. Store one instead:

```sh
dem auth add openai        # prompts, does not echo, does not touch shell history
dem auth list              # names and dates, never values
```

Then reference it by name: `"apiKey": "secret://openai"`. The store is
`~/.dem/credentials.json` — your home directory, never a workspace, owner-only
where the platform can express that, and not encrypted. `dem auth` tells you
all of that rather than implying more.

Give each provider its own name, and give the endpoint a place to live beside
it — `dem auth` stores the key and nothing else, which on its own is half a
configuration:

```json
{
  "providers": {
    "qwen-27b":   {"baseUrl": "http://...:8002/v1", "model": "qwen3.8-27b",        "apiKey": "secret://qwen-27b"},
    "qwen-flash": {"baseUrl": "http://...:8000/v1", "model": "qwen3.8-flash-next", "apiKey": "secret://qwen-flash"}
  }
}
```

Then `dem --provider qwen-27b run "..."`. When several are configured and you
name none, that is an error rather than a guess — picking one silently would
send this workspace to an endpoint you did not choose.

`"apiKey": "env://OPENAI_API_KEY"` still works and is what CI wants, since a
pipeline has no prompt to answer. `secret://` never falls back to the
environment: a reference that quietly resolved from somewhere else is how you
come to believe a key is stored when it is not.

## Providers

```sh
dem --model qwen run "..."                       # a local OpenAI-compatible server
dem --provider claude-cli --allow-remote run ... # the Claude Code CLI, on your subscription
dem --provider anthropic --allow-remote run ...  # the Anthropic API (bills per request)
```

Anything that sends context off the machine is refused unless `--allow-remote` (or `"allowRemote": true`), and `dem models` states `LOCAL` or `REMOTE` before listing anything. The Claude CLI counts as remote even though the binary is local: the gate follows the data, not the executable.

The two Claude adapters look interchangeable and are not:

| | Billing | Tool calling |
|---|---|---|
| `claude-cli` | Draws on your subscription's rate-limit window — the same one you use for your own work | **No.** Its own tools are stripped to keep them out of our permission broker |
| `anthropic` | Bills per request against an API key | Yes |

The harness's tests call neither. For work a model should do end to end, delegate instead.

The permission ceiling is `ASK` and stays there until a sandbox adapter lands in v0.2 (SPEC §19.1).

## Delegate

```sh
dem --allow-remote delegate "fix the failing auth test"
```

The agent runs in a copy of the workspace with its own tools, and its changes come back as a proposal you approve file by file before anything here is touched. While it runs, this harness guarantees nothing about what it does — the record says so (SPEC §4.2).

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
pnpm run build      # emit runnable JavaScript into dist/
```

`pnpm run check` is expected to fail on the test step during Phase 0. What must hold is that every failure is a `NotImplemented` naming the test ID it owes work to — `tests/phase0-contract.test.ts` asserts exactly that, and it passes.

### Working order

A test goes red before its module is written. `tests/phase0-contract.test.ts` is the guard against the shortcut where a stub quietly returns a plausible value and turns a suite green without implementing anything.

### Environment

- Node 20.18+ (developed on 20; `scripts/` avoids Node 22-only APIs)
- pnpm 12+
- Reference environment on Windows is **WSL2**. Native Windows runs the harness but has no sandbox adapter, so `AUTO` is unavailable and `ASK` is the ceiling — see SPEC §19.1.

Two native-Windows caveats, both absent under WSL2:

- **Process tree cleanup is best-effort.** POSIX spawns children detached and kills the whole group at once. Windows has no equivalent here, and `taskkill /t /f` was measured at a consistent ~3.8s on a managed host, so waiting for it would stall every cancel and timeout by that much. The direct child is terminated immediately and the tree walk runs unawaited, which can leave an orphan under a deep tree.
- **`SEC-004` needs a link the host can create.** A file symlink requires Developer Mode or elevation; a directory junction requires neither. The fixture builds both and throws if it can get neither, rather than letting the test pass unexercised.

## Scope of v0.1

A safe single-agent CLI harness: authenticated daemon, sessions, audit, `read`/`grep`/`glob`/`patch`/`shell`/`terminal`, path guard, permission broker, sanitized child environment, secret broker, memory, compaction, cancellation, budgets.

Not in v0.1: sandbox adapter, `AUTO` mode, council, counterexample execution, Web UI.

## License

Apache-2.0
