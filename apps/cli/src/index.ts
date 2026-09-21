import { homedir } from "node:os";
import { join } from "node:path";
// `providerFromSettings` is deliberately not imported: resolving the
// provider a second time, from the flat settings, is what printed "fake
// (no provider configured)" over a session answering from a real model.
import { providerFromChosen, startDaemon } from "@dem/daemon";
import {
  applyDelegated,
  delegate,
  effectiveProvider,
  ensureModelServer,
  explainSmokeFailure,
  resolveSettings,
  runSmokeTest,
  writeCredential,
  type ModelServer,
  type Settings,
} from "@dem/engine";
import { ClaudeCodeAgent, CodexAgent } from "@dem/adapters";
import type { ProposedChange } from "@dem/engine";
import type { DaemonHandle, SessionEvent } from "@dem/protocol";
import { runInteractive } from "./interactive.js";
import { runTui } from "./tui/index.js";
import { readLine, runOnce, showLog } from "./commands.js";
import { runAuth } from "./auth.js";
import { runSetup, SETUP_DONE } from "./setup.js";

import { pickAtStart } from "./tui/start.js";
import { applyStartChoice } from "./tui/apply-choice.js";
import { readFile as readConfigFile, writeFile as writeConfigFile, mkdir as makeDir } from "node:fs/promises";

export { createSession, renderSince, runTurn } from "./session-ui.js";
export type { Approver, PendingCall } from "./session-ui.js";
export { sessionApprover } from "./interactive.js";
export { otherProviders, runSessionCommand, SESSION_COMMANDS } from "./session-commands.js";
export { appendDelta, line, settle, trim } from "./tui/state.js";
export { applyStartChoice } from "./tui/apply-choice.js";
export type { Line, Prompt, SessionState } from "./tui/state.js";
export type { SessionCommand, SessionCommandResult } from "./session-commands.js";
export type { Ask } from "./interactive.js";

/**
 * `dem` CLI (plan 4.5). The reference UX; Web and Desktop are later shells
 * over the same daemon and the same session.
 *
 * The CLI owns no agent logic. It starts or attaches to a daemon and renders
 * the event stream, which is what keeps the three shells from drifting apart.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const consoleIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
};

/** SPEC section 34: local state lives in ~/.dem, matching the command name. */
export function defaultStateDir(): string {
  return join(homedir(), ".dem");
}

const HELP = `dem — local-first AI agent harness

Getting started:
  dem setup            find a model on this machine and write the config
  dem models           check what dem can reach, and whether it leaves here
  dem run "..."        ask one question

Usage:
  dem                  start an interactive session
  dem run <prompt>     run one prompt to completion and print the answer
  dem log <ses_id>     show what happened in a session
  dem delegate <task>  hand the whole task to an external agent
  dem auth add <name>  store a credential for a remote provider
  dem models           list providers this daemon can reach
  dem help             show this message

Options (override config for this run):
  --model <name>       model to use
  --provider <kind>    anthropic | claude-cli | (default: OpenAI-compatible)
  --agent <kind>       claude-code | codex, for delegate
  --allow-remote       permit anything that sends context off this machine
  --skip-smoke-test    run even if this model configuration fails its check

Configuration is read from .dem/config.json in this workspace and in your home
directory, then the environment, then these flags (SPEC 33). Write the model
down once instead of re-typing it:

  {"baseUrl": "http://127.0.0.1:8099", "model": "qwen-coder"}

Credentials are never written in config as literals, because config files get
committed. Store one with 'dem auth add <name>' and reference it:

  {"apiKey": "secret://openai"}

An environment variable still works — "apiKey": "env://OPENAI_API_KEY" — which
is what CI wants, since a pipeline has no prompt to answer.

Status: v0.1 in progress. Permission mode is ASK and cannot be raised:
no sandbox adapter ships in v0.1, and AUTO without one is not offered.
`;

/**
 * Settings for this invocation, from flags, environment and config files
 * (SPEC 33). Loaded once so every command sees the same answer, and so a
 * config error is reported before any work starts rather than halfway in.
 */
async function settingsFor(argv: readonly string[]): Promise<Settings> {
  const cli: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) cli["model"] = argv[++i];
    else if (arg === "--provider" && argv[i + 1]) cli["provider"] = argv[++i];
    else if (arg === "--agent" && argv[i + 1]) cli["agent"] = argv[++i];
    else if (arg === "--allow-remote") cli["allowRemote"] = true;
    else if (arg === "--skip-smoke-test") cli["skipSmokeTest"] = true;
  }

  return resolveSettings({
    workspace: process.cwd(),
    home: homedir(),
    env: process.env,
    cli,
  });
}

/** Strip the flags settingsFor consumed, leaving the command and its words. */
function withoutFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model" || arg === "--provider" || arg === "--agent") { i++; continue; }
    if (arg === "--allow-remote" || arg === "--skip-smoke-test") continue;
    out.push(arg);
  }
  return out;
}

/**
 * Is there a model to talk to?
 *
 * The fake provider exists for tests, and a user who has configured nothing
 * should meet setup rather than an echo. Anything that names an endpoint, a
 * weights file or a provider kind counts; the rest is checked when it runs.
 */
function isConfigured(settings: Settings): boolean {
  return Boolean(
    settings.baseUrl ?? settings.modelPath ?? settings.provider ?? settings.providers,
  );
}

/**
 * The fake provider is still reachable, by asking for it.
 *
 * `--provider fake` is how the test suite and anyone poking at the harness
 * gets a deterministic model without one installed. What changed is that it is
 * no longer what a user gets by default for having configured nothing.
 */

export async function main(rawArgv: readonly string[], io: Io = consoleIo): Promise<number> {
  let settings: Settings;
  try {
    settings = await settingsFor(rawArgv);
  } catch (err) {
    // A config that does not apply is reported before anything runs.
    io.err(`dem: ${(err as Error).message}
`);
    return 2;
  }

  const [command, ...rest] = withoutFlags(rawArgv);

  switch (command) {
    case undefined:
      // An interactive session needs someone to be there. Opening a prompt on
      // a pipe waits for input that will never come, so `dem` in a script
      // would hang rather than fail.
      if (!process.stdin.isTTY) {
        io.out(HELP);
        return 0;
      }
      // No separate first-run path. The menu below handles an empty config
      // the same way it handles a full one — it lists what is on the machine
      // and offers to add what is not — so a new user and a returning one see
      // the same screen rather than two that show the same things differently.

      // Choose before connecting.
      //
      // Resolving whatever was configured and connecting meant that an
      // unreachable endpoint produced a check that refused to open a session,
      // and the only thing that can change the provider lives inside the
      // session that would not open. Choosing first has nothing to be locked
      // out of, and it is what someone with several models wants anyway.
      if (!process.env["DEM_PLAIN"] && !rawArgv.includes("--provider")) {
        const chosen = await startMenu(process.cwd(), settings, io);
        if (chosen === undefined) return 0;
        settings = await settingsFor(rawArgv);
      }

      return withDaemon(settings, io, (daemon, endpoint) =>
        // The full-screen session. `runInteractive` remains the line-based
        // one, used where a renderer cannot run — a dumb terminal, a CI log —
        // and both drive the same turn, approval and command code.
        process.env["DEM_PLAIN"]
          ? runInteractive(daemon, settings, process.cwd(), endpoint.local, endpoint.label, io)
          : runTui(daemon, settings, process.cwd(), endpoint.local, endpoint.label, endpoint),
      );

    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

    case "setup": {
      // Run on its own, setup configures and stops.
      const code = await runSetup(io, process.cwd());
      return code === SETUP_DONE ? 0 : code;
    }

    case "auth":
      // No daemon and no provider: storing a credential must work before
      // anything is configured, which is when a user first needs it.
      return runAuth(rest, io);

    case "log": {
      const id = rest[0];
      if (!id) {
        io.err("dem log: a session id is required\n");
        return 2;
      }
      return withDaemon(settings, io, (daemon) => showLog(daemon, id, io));
    }

    case "run": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        io.err("dem run: a prompt is required\n");
        return 2;
      }
      return withDaemon(settings, io, (daemon) => runOnce(daemon, prompt, process.cwd(), io));
    }

    case "models":
      return withDaemon(settings, io, async (daemon, endpoint) => {
        // Privacy posture is stated before the model list, not inferred from
        // it. Whether context leaves the machine is the first thing a user
        // needs to know and the easiest thing to forget you configured.
        io.out(`${endpoint.local ? "LOCAL " : "REMOTE"}  ${endpoint.label}\n\n`);

        const res = await fetch(`${daemon.url}/models`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        const body = (await res.json()) as { models: Array<{ id: string; capabilities: string[] }> };
        for (const model of body.models) {
          io.out(`${model.id}\n  ${model.capabilities.join(", ")}\n`);
        }
        return 0;
      });

    case "delegate": {
      const task = rest.join(" ").trim();
      if (!task) {
        io.err("dem delegate: a task is required\n");
        return 2;
      }
      return runDelegation(task, settings, io);
    }

    default:
      io.err(`dem: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

/**
 * Hand the whole task to an external agent (SPEC §4.2).
 *
 * Two approvals, not one. The first is to let the agent run at all, since the
 * task and every file it reads leave the machine and the harness stops
 * guaranteeing anything while it works. The second is to apply what it wrote,
 * with the file list in view. Collapsing them into one question would mean
 * consenting to an unseen diff at the moment of deciding whether to start.
 */
async function runDelegation(task: string, settings: Settings, io: Io): Promise<number> {
  // Two vendors, chosen explicitly. Later a council of both is the point: two
  // agents that share a failure mode agree confidently and wrongly.
  const which = settings.agent ?? "claude-code";

  if (which !== "codex" && which !== "claude-code") {
    io.err(`dem: unknown agent "${which}"; expected claude-code or codex\n`);
    return 2;
  }

  const model = settings.model;
  const agent =
    which === "codex"
      ? new CodexAgent(model ? { model } : {})
      : new ClaudeCodeAgent({ model: model ?? "sonnet" });

  if (!agent.isLocal() && !settings.allowRemote) {
    io.err(
      `dem: delegating to ${agent.id} sends the task and the files it reads to a third party, ` +
        `and suspends this harness's guarantees while it runs. ` +
        `Pass --allow-remote, or set "allowRemote": true in .dem/config.json.\n`,
    );
    return 1;
  }

  io.err(`[1mdelegating to ${agent.id}[0m\n`);
  io.err("[2mruns in a copy of this workspace; nothing here changes until you approve[0m\n\n");

  const outcome = await delegate(agent, { workspace: process.cwd(), task, approved: false });

  io.err(`[2m${outcome.agentLog.slice(0, 2000)}[0m\n\n`);

  if (!outcome.ok) {
    io.err("the agent did not finish successfully; nothing applied\n");
    return 1;
  }
  if (outcome.changes.length === 0) {
    io.err("the agent proposed no changes\n");
    return 0;
  }

  io.err(`\n[1m${outcome.changes.length} file(s) proposed[0m\n`);
  outcome.changes.forEach((change, i) => {
    io.err(`  ${i + 1}. ${change.kind === "create" ? "+" : "~"} ${change.path}\n`);
  });

  const selected = await selectChanges(outcome.changes, io);
  if (selected.length === 0) {
    io.err("\nnothing applied\n");
    return 1;
  }

  // Applies the change set already shown, rather than running the agent again.
  // A second run would cost a second call and, worse, produce a different diff
  // from the one the user just approved.
  const applied = await applyDelegated(process.cwd(), selected);
  if (!applied.applied) {
    io.err(`\nnot applied: changed underneath — ${applied.conflicts.join(", ")}\n`);
    return 1;
  }

  io.out(`applied ${selected.length} file(s)\n`);
  return 0;
}

/**
 * Choose which proposed files to take.
 *
 * All-or-nothing is the wrong shape here. An agent working in a copy leaves
 * its own litter behind — a real run of this produced the file it was asked
 * for plus a stray `stdout` from a shell redirect — and a user who wants one
 * and not the other should not have to choose between taking junk and
 * discarding the work.
 */
async function selectChanges(
  changes: readonly ProposedChange[],
  io: Io,
): Promise<ProposedChange[]> {
  io.err("\n[2mguarantees were suspended while the agent ran[0m\n");
  io.err("apply? [a]ll / [n]one / numbers e.g. 1,3 : ");

  if (!process.stdin.isTTY) {
    // A pipe cannot consent. Defaulting to all would make every scripted run
    // apply whatever an agent happened to leave in the copy.
    io.err("\nno tty; declining\n");
    return [];
  }

  const answer = await readLine();
  io.err("\n");

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "a" || trimmed === "all" || trimmed === "y") return [...changes];
  if (!trimmed || trimmed === "n" || trimmed === "none") return [];

  const picked = new Set(
    trimmed
      .split(/[,\s]+/)
      .map((n: string) => Number.parseInt(n, 10))
      .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= changes.length),
  );
  return changes.filter((_, i) => picked.has(i + 1));
}


/**
 * The start menu, and writing down what it chose.
 *
 * Written to config rather than held for this run only: picking a model is a
 * decision about this workspace, and a choice that evaporates means making it
 * again every time.
 *
 * @returns undefined when the user left without choosing.
 */
async function startMenu(
  workspace: string,
  settings: Settings,
  io: Io,
): Promise<true | undefined> {
  const providers = settings.providers ?? {};
  const names = Object.keys(providers);

  const choice = await pickAtStart({
    workspace,
    configured: names.map((name) => ({
      name,
      detail: [providers[name]?.model, providers[name]?.baseUrl].filter(Boolean).join("  "),
      current: name === settings.provider,
    })),
    ...(settings.baseUrl
      ? { flat: { detail: [settings.model, settings.baseUrl].filter(Boolean).join("  ") } }
      : {}),
  });

  if (choice.cancelled) return undefined;

  const path = join(workspace, ".dem", "config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readConfigFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {
    // No config yet, which a chosen endpoint is about to create.
  }


  if (choice.manual) {
    // Collected by the menu itself. Dropping out to a readline prompt after
    // Ink has unmounted reads nothing — Ink leaves stdin in raw mode, so the
    // questions appeared and the process exited without taking an answer.
    const entered = choice.manual;
    const providers = (config["providers"] ?? {}) as Record<string, unknown>;

    const provider: Record<string, unknown> = { baseUrl: entered.baseUrl };
    if (entered.model) provider["model"] = entered.model;

    if (entered.apiKey) {
      // Into the credential store, never into the config file (invariant 6).
      await writeCredential(entered.name, entered.apiKey, homedir());
      provider["apiKey"] = `secret://${entered.name}`;
    }

    providers[entered.name] = provider;
    config["providers"] = providers;
    config["provider"] = entered.name;

    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(entered.baseUrl)) {
      io.err(
        "[2mthis endpoint is not on this machine; prompts and files read will be sent to it[0m\n",
      );
      config["allowRemote"] = true;
    }

    await makeDir(join(workspace, ".dem"), { recursive: true });
    await writeConfigFile(path, JSON.stringify(config, null, 2) + "\n");
    return true;
  }

  if (!choice.provider && !choice.newEndpoint) {
    return true; // The flat configuration, already what settings say.
  }
  applyStartChoice(config, choice);

  await makeDir(join(workspace, ".dem"), { recursive: true });
  await writeConfigFile(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

async function withDaemon(
  settings: Settings,
  io: Io,
  fn: (
    d: DaemonHandle,
    endpoint: {
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      /** What this run is actually talking to, for the header. */
      label: string;
      local: boolean;
    },
  ) => Promise<number>,
): Promise<number> {
  const stateDir = defaultStateDir();

  if (!isConfigured(settings)) {
    io.err(
      "dem: no model is configured, so there is nothing to ask.\n\n" +
        "  Run \u001b[1mdem setup\u001b[0m - it looks for a server or weights already here.\n\n",
    );
    return 2;
  }

  // Which endpoint, and its credential (SPEC 33.2).
  //
  // A configured name carries its own baseUrl, model and credential reference,
  // so two endpoints no longer have to share one setting — which is what made
  // a council impossible to configure. A setup with no named providers reads
  // exactly as before, from the flat settings.
  let provider;
  let chosen;
  let selection;
  try {
    chosen = await effectiveProvider(settings);
    selection = providerFromChosen(chosen, settings.allowRemote);
    provider = selection.provider;
  } catch (err) {
    io.err(`dem: ${(err as Error).message}\n`);
    return 1;
  }

  // A configured local model is served by us if nothing is serving it already.
  // Without this the local path needed a second terminal and a port kept in
  // sync by hand, which made the case this harness is built around the most
  // awkward one to use.
  let modelServer: ModelServer | undefined;
  // Only when this run is actually going to that server. A built-in kind —
  // `fake`, `anthropic`, `claude-cli` — overrides the endpoint in config, and
  // loading weights for a provider the run will not use costs minutes and
  // then fails a smoke test against a server nothing asked for.
  const usesConfiguredEndpoint = !chosen.kind;
  // Weights belong to the endpoint they are served at, not to the session.
  // Read from the chosen provider: with `modelPath` at the top level and a
  // remote provider selected, this loaded 5.8GB, waited for it, and then
  // talked to the remote endpoint anyway.
  if (usesConfiguredEndpoint && chosen.modelPath && chosen.baseUrl) {
    try {
      io.err(`\u001b[2mstarting a model server at ${chosen.baseUrl}\u001b[0m\n`);
      modelServer = await ensureModelServer(chosen.baseUrl, {
        modelPath: chosen.modelPath,
        command: settings.llamaCommand,
        contextSize: settings.contextSize,
        // Loading several gigabytes takes a while, and a terminal that shows
        // nothing for a minute looks hung.
        onProgress: (note) => io.err(`\u001b[2m${note}...\u001b[0m\n`),
      });
      if (modelServer.started) io.err(`[2mready[0m\n`);
    } catch (err) {
      io.err(`dem: ${(err as Error).message}\n`);
      return 1;
    }
  }

  // Is this configuration working at all (invariant 44, SPEC 25.3)?
  //
  // A published figure describes a model; the weight of trust is placed on a
  // deployment. On the reference machine, adding `-ctk q4_0` to fit the card
  // took a model from 46/60 to 0/60 while still answering in 1.4 seconds, so
  // anything that checks only for a response passes it.
  //
  // Five trivial questions, cached by configuration, re-run when the model
  // file, quantization or server flags change. Seconds once per setup.
  //
  // Only for a model this machine serves. The built-in fake has nothing to
  // prove, and a remote endpoint would be probed with the user's own quota to
  // catch failure modes — a quantized cache, a GGUF with no chat template —
  // that only exist when we are the ones serving the weights.
  // Any endpoint this run will actually talk to, local or not.
  //
  // This was scoped to models served here, to avoid spending someone's paid
  // quota on failure modes that only exist when we serve the weights. That
  // reasoning was about the failure modes, and it skipped the one thing every
  // endpoint can fail at: being reachable. A configured remote provider went
  // straight into a session that could not answer a single message.
  const checkable = usesConfiguredEndpoint && Boolean(chosen.baseUrl ?? chosen.modelPath);

  let toolCalling: boolean | undefined;
  if (checkable && !settings.skipSmokeTest) {
    const smokeConfig = {
      model: chosen.model ?? settings.model,
      baseUrl: chosen.baseUrl ?? settings.baseUrl,
      modelPath: chosen.modelPath,
      args: settings.llamaArgs,
    };
    const smoke = await runSmokeTest(provider, {
      config: smokeConfig,
      cacheDir: stateDir,
      // Asked here because it is the one place that already proves a
      // configuration, and because offering tools to an endpoint that cannot
      // call them makes every message come back a refusal (invariant 41).
      probeTools: true,
    });
    toolCalling = smoke.toolCalling;
    if (!smoke.ok) {
      io.err(`dem: ${explainSmokeFailure(smoke, smokeConfig)}
`);
      io.err(`  Pass --skip-smoke-test to run anyway.
`);
      if (modelServer?.started) await modelServer.stop();
      return 1;
    }
  }

  // Rebuilt when the probe says this endpoint does not call tools, so the
  // agent loop offers none and tells the model so, rather than dangling tools
  // it cannot use in front of it.
  if (toolCalling === false && !chosen.kind) {
    provider = providerFromChosen({ ...chosen, toolCalling: false }, settings.allowRemote).provider;
    io.err(
      `[2mthis model cannot call tools, so none are offered[0m\n`,
    );
  }

  const daemon = await startDaemon({ workspace: process.cwd(), stateDir, provider });
  try {
    // The endpoint this run resolved to, handed on so a session command does
    // not have to re-derive it - and get it wrong for a named provider.
    // The label and locality come from the selection this run made, not from
    // a second resolution of the flat settings. Computing it twice printed
    // "fake (no provider configured)" over a session answering from a real
    // model, because a named provider leaves the flat fields empty.
    return await fn(daemon, {
      baseUrl: chosen.baseUrl,
      apiKey: chosen.apiKey,
      label: selection.label,
      local: selection.local,
    });
  } catch (err) {
    io.err(`dem: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await daemon.close();
    // Only stop what we started. A server the user was already running keeps
    // running — loading a model takes long enough that killing someone else's
    // is a real cost, not a tidy-up.
    if (modelServer?.started) await modelServer.stop();
  }
}

