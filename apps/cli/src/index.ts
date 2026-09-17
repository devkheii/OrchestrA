import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProvider, startDaemon } from "@dem/daemon";
import { applyDelegated, delegate } from "@dem/engine";
import { ClaudeCodeAgent, CodexAgent } from "@dem/adapters";
import type { DaemonHandle, SessionEvent } from "@dem/protocol";

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
  dem run <prompt>     run one prompt to completion and print the answer
  dem delegate <task>  hand the whole task to an external agent
                       DEM_AGENT=claude-code (default) or codex
  dem models           list providers this daemon can reach
  dem help             show this message

Status: v0.1 in progress. Permission mode is ASK and cannot be raised:
no sandbox adapter ships in v0.1, and AUTO without one is not offered.
`;

export async function main(argv: readonly string[], io: Io = consoleIo): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

    case "run": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        io.err("dem run: a prompt is required\n");
        return 2;
      }
      return withDaemon(io, (daemon) => runOnce(daemon, prompt, io));
    }

    case "models":
      return withDaemon(io, async (daemon) => {
        const selection = resolveProvider(process.env);
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
      return runDelegation(task, io);
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
async function runDelegation(task: string, io: Io): Promise<number> {
  // Two vendors, chosen explicitly. Later a council of both is the point: two
  // agents that share a failure mode agree confidently and wrongly.
  const which = process.env["DEM_AGENT"] ?? "claude-code";
  const model = process.env["DEM_MODEL"];
  const agent =
    which === "codex"
      ? new CodexAgent(model ? { model } : {})
      : new ClaudeCodeAgent({ model: model ?? "sonnet" });

  if (which !== "codex" && which !== "claude-code") {
    io.err(`dem: unknown agent "${which}"; expected claude-code or codex
`);
    return 2;
  }

  if (!agent.isLocal() && process.env["DEM_ALLOW_REMOTE"] !== "1") {
    io.err(
      `dem: delegating to ${agent.id} sends the task and the files it reads to a third party, ` +
        `and suspends this harness's guarantees while it runs. ` +
        `Set DEM_ALLOW_REMOTE=1 to accept that.\n`,
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

  io.err(`[1m${outcome.changes.length} file(s) proposed[0m\n`);
  for (const change of outcome.changes) {
    io.err(`  ${change.kind === "create" ? "+" : "~"} ${change.path}\n`);
  }

  const approved = await askApproval(
    {
      call: { id: "delegation", name: "apply changes", arguments: {} },
      rule: "guarantees were suspended while the agent ran",
    },
    io,
  );
  if (!approved) {
    io.err("\nnot applied\n");
    return 1;
  }

  // Applies the change set already shown, rather than running the agent again.
  // A second run would cost a second call and, worse, produce a different diff
  // from the one the user just approved.
  const applied = await applyDelegated(process.cwd(), outcome.changes);
  if (!applied.applied) {
    io.err(`\nnot applied: changed underneath — ${applied.conflicts.join(", ")}\n`);
    return 1;
  }

  io.out(`applied ${outcome.changes.length} file(s)\n`);
  return 0;
}

interface RunOutcome {
  status: string;
  detail?: string;
  pending?: { call: { id: string; name: string; arguments: Record<string, unknown> }; rule: string };
}

/** Print tool activity the user has not seen yet. Returns the new watermark. */
async function renderProgress(
  daemon: DaemonHandle,
  id: string,
  io: Io,
  from: number,
): Promise<number> {
  const res = await fetch(`${daemon.url}/sessions/${id}/events?since=${from}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const { events } = (await res.json()) as { events: SessionEvent[] };

  for (const event of events) {
    if (event.type === "tool.finished") {
      io.err(`[2m● ${event.tool}${event.ok ? "" : " (failed)"}[0m\n`);
    }
  }
  return events.at(-1)?.seq ?? from;
}

/**
 * Ask the user about one pending call.
 *
 * The exact command is printed, not a summary of it. A prompt that says
 * "run a shell command?" trains the user to say yes without reading, which
 * turns every later approval into a formality.
 */
async function askApproval(
  pending: NonNullable<RunOutcome["pending"]>,
  io: Io,
): Promise<boolean> {
  const { call, rule } = pending;
  const detail =
    typeof call.arguments["command"] === "string"
      ? call.arguments["command"]
      : JSON.stringify(call.arguments);

  io.err(`\n[1m${call.name}[0m  ${detail}\n`);
  io.err(`[2m${rule}[0m\n`);
  io.err("allow? [y/N] ");

  if (!process.stdin.isTTY) {
    // Non-interactive: refuse rather than assume. A pipe cannot consent, and
    // defaulting to yes would make every scripted run auto-approving.
    io.err("\nno tty; declining\n");
    return false;
  }

  return new Promise<boolean>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      const answer = chunk.trim().toLowerCase();
      io.err("\n");
      resolve(answer === "y" || answer === "yes");
    });
  });
}

async function withDaemon(io: Io, fn: (d: DaemonHandle) => Promise<number>): Promise<number> {
  const stateDir = defaultStateDir();
  const daemon = await startDaemon({ workspace: process.cwd(), stateDir });
  try {
    return await fn(daemon);
  } catch (err) {
    io.err(`dem: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await daemon.close();
  }
}

async function runOnce(daemon: DaemonHandle, prompt: string, io: Io): Promise<number> {
  const headers = {
    authorization: `Bearer ${daemon.token}`,
    "content-type": "application/json",
  };

  const created = await fetch(`${daemon.url}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace: process.cwd() }),
  });
  const { id } = (await created.json()) as { id: string };

  let outcome = (await (
    await fetch(`${daemon.url}/sessions/${id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: prompt }),
    })
  ).json()) as RunOutcome;

  let shown = 0;

  // The run stops at each approval rather than queueing them, so the user is
  // answering one concrete command at a time instead of a batch they would
  // skim. Work already done is printed before the question, so the decision is
  // made with the transcript in view.
  while (outcome.status === "awaiting_approval" && outcome.pending) {
    shown = await renderProgress(daemon, id, io, shown);

    const approved = await askApproval(outcome.pending, io);
    if (!approved) {
      io.err("\ndeclined; stopping here\n");
      return 1;
    }

    outcome = (await (
      await fetch(`${daemon.url}/sessions/${id}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ callId: outcome.pending.call.id }),
      })
    ).json()) as RunOutcome;
  }

  if (outcome.status === "budget") io.err(`\n${outcome.detail}\n`);

  const events = await fetch(`${daemon.url}/sessions/${id}/events`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const { events: log } = (await events.json()) as { events: SessionEvent[] };

  // Rationale goes to stderr, dimmed and prefixed. Visible while working, but
  // never mixed into the answer a pipe or a script consumes — the separation
  // the event stream keeps is only worth having if the display keeps it too.
  const rationale = log
    .filter((e) => e.type === "answer.rationale")
    .map((e) => e.text)
    .join("");

  if (rationale) {
    io.err("[2m┌ reasoning[0m\n");
    for (const line of rationale.split("\n")) {
      io.err(`[2m│ ${line}[0m\n`);
    }
    io.err("[2m└[0m\n\n");
  }

  for (const event of log) {
    if (event.type === "tool.finished") {
      io.err(`[2m● ${event.tool}${event.ok ? "" : " (failed)"}[0m\n`);
    }
  }
  if (log.some((e) => e.type === "tool.finished")) io.err("\n");

  for (const event of log) {
    if (event.type === "answer.delta") io.out(event.text);
  }
  io.out("\n");

  const failed = log.some((e) => e.type === "session.completed" && e.status === "error");
  // The session id is the handle for `dem log` later, so it is always shown.
  io.err(`\nsession ${id}\n`);
  return failed ? 1 : 0;
}
