import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@dem/daemon";
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
        const res = await fetch(`${daemon.url}/models`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        const body = (await res.json()) as { models: Array<{ id: string; capabilities: string[] }> };
        for (const model of body.models) {
          io.out(`${model.id}\n  ${model.capabilities.join(", ")}\n`);
        }
        return 0;
      });

    default:
      io.err(`dem: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
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

  await fetch(`${daemon.url}/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: prompt }),
  });

  const events = await fetch(`${daemon.url}/sessions/${id}/events`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const { events: log } = (await events.json()) as { events: SessionEvent[] };

  for (const event of log) {
    if (event.type === "answer.delta") io.out(event.text);
  }
  io.out("\n");

  const failed = log.some((e) => e.type === "session.completed" && e.status === "error");
  // The session id is the handle for `dem log` later, so it is always shown.
  io.err(`\nsession ${id}\n`);
  return failed ? 1 : 0;
}
