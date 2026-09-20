import { homedir } from "node:os";
import { join } from "node:path";
import { providerFromSettings, startDaemon } from "@dem/daemon";
import {
  applyDelegated,
  delegate,
  ensureModelServer,
  explainSmokeFailure,
  resolveSettings,
  runSmokeTest,
  type ModelServer,
  type Settings,
} from "@dem/engine";
import { ClaudeCodeAgent, CodexAgent } from "@dem/adapters";
import type { ProposedChange } from "@dem/engine";
import type { DaemonHandle, SessionEvent } from "@dem/protocol";
import { runInteractive } from "./interactive.js";
import { readLine, runOnce, showLog } from "./commands.js";
import { runAuth } from "./auth.js";

export { createSession, renderSince, runTurn } from "./session-ui.js";
export type { Approver, PendingCall } from "./session-ui.js";
export { sessionApprover } from "./interactive.js";
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
      return withDaemon(settings, io, (daemon) => {
        const selection = providerFromSettings(settings);
        return runInteractive(daemon, settings, process.cwd(), selection.local, selection.label, io);
      });

    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

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
      return withDaemon(settings, io, async (daemon) => {
        const selection = providerFromSettings(settings);
        // Privacy posture is stated before the model list, not inferred from
        // it. Whether context leaves the machine is the first thing a user
        // needs to know and the easiest thing to forget you configured.
        io.out(`${selection.local ? "LOCAL " : "REMOTE"}  ${selection.label}\n\n`);

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

async function withDaemon(
  settings: Settings,
  io: Io,
  fn: (d: DaemonHandle) => Promise<number>,
): Promise<number> {
  const stateDir = defaultStateDir();

  // The provider comes from resolved settings, so a model written once in
  // .dem/config.json is the model the daemon runs with.
  let provider;
  try {
    provider = providerFromSettings(settings).provider;
  } catch (err) {
    io.err(`dem: ${(err as Error).message}\n`);
    return 1;
  }

  // A configured local model is served by us if nothing is serving it already.
  // Without this the local path needed a second terminal and a port kept in
  // sync by hand, which made the case this harness is built around the most
  // awkward one to use.
  let modelServer: ModelServer | undefined;
  if (settings.modelPath && settings.baseUrl) {
    try {
      modelServer = await ensureModelServer(settings.baseUrl, {
        modelPath: settings.modelPath,
        command: settings.llamaCommand,
        contextSize: settings.contextSize,
      });
      if (modelServer.started) {
        io.err(`[2mstarted a model server at ${settings.baseUrl}[0m\n`);
      }
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
  const servesLocally =
    providerFromSettings(settings).local && Boolean(settings.modelPath ?? settings.baseUrl);

  if (servesLocally && !settings.skipSmokeTest) {
    const smokeConfig = {
      model: settings.model,
      modelPath: settings.modelPath,
      args: settings.llamaArgs,
    };
    const smoke = await runSmokeTest(provider, { config: smokeConfig, cacheDir: stateDir });
    if (!smoke.ok) {
      io.err(`dem: ${explainSmokeFailure(smoke, smokeConfig)}
`);
      io.err(`  Pass --skip-smoke-test to run anyway.
`);
      if (modelServer?.started) await modelServer.stop();
      return 1;
    }
  }

  const daemon = await startDaemon({ workspace: process.cwd(), stateDir, provider });
  try {
    return await fn(daemon);
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

