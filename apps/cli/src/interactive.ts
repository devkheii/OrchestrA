import { createInterface } from "node:readline/promises";
import type { DaemonHandle } from "@dem/protocol";
import type { Settings } from "@dem/engine";
import { createSession, runTurn, type Approver, type Io } from "./session-ui.js";
import { runSessionCommand, SESSION_COMMANDS } from "./session-commands.js";

/**
 * The interactive session (plan 4.5).
 *
 * One session for the whole conversation, so a follow-up question builds on
 * what came before. `dem run` was a single question with the session discarded
 * afterwards, which made this a query tool rather than something to work with.
 *
 * The daemon stays up for the duration and the session id stays fixed, so the
 * loop that rebuilds the conversation from the event log gets a growing log
 * rather than a fresh one each time.
 */

const BANNER = (settings: Settings, workspace: string, local: boolean, label: string) =>
  [
    "",
    `[1mdem[0m  ${workspace}`,
    `${local ? "[2mLOCAL [0m" : "[1mREMOTE[0m"}  ${label}`,
    `[2mmode ${settings.security.maxMode}[0m`,
    "",
    // Every command, every time, rather than a pointer to /help. A session
    // whose capabilities are discoverable only by typing the right word is
    // one where most people never learn it can change models at all.
    ...SESSION_COMMANDS.map(
      (c) => `  [2m${(c.usage ?? c.name).padEnd(34)}${c.summary}[0m`,
    ),
    "",
  ].join("\n");


/** Reads one line of an answer. Injected so the prompt can be tested. */
export type Ask = (question: string) => Promise<string>;

/**
 * The approval prompt, with a session-scoped "always".
 *
 * SPEC §19 defines four approval scopes and only "once" was implemented, which
 * meant confirming `npm test` on every iteration of a fix-and-rerun loop. An
 * approval asked too often stops being read, and an approval nobody reads is
 * worse than none.
 *
 * Scoped per tool *and* per subject: saying yes to `npm test` does not say yes
 * to `rm -rf build`. The scope is the process — nothing is written to disk,
 * so it cannot outlive the session a user granted it for.
 */
export function sessionApprover(ask: Ask, io: Io): Approver {
  const allowed = new Set<string>();

  return async (pending) => {
    const detail = subjectOf(pending.call.arguments);
    const key = `${pending.call.name}:${detail}`;

    if (allowed.has(key)) {
      io.err(`[2m● ${pending.call.name} ${detail} (allowed earlier this session)[0m
`);
      return true;
    }

    io.err(`
[1m${pending.call.name}[0m  ${detail}
`);
    io.err(`[2m${pending.rule}[0m
`);

    const answer = (await ask("allow? [y]es / [a]lways this session / [N]o ")).trim().toLowerCase();

    if (answer === "a" || answer === "always") {
      allowed.add(key);
      return true;
    }
    // Anything unrecognised is a no. A mistyped key must not approve.
    return answer === "y" || answer === "yes";
  };
}

/**
 * What the user is actually being asked about. The command itself when there
 * is one, since that is what they read; the whole argument object otherwise,
 * because a tool named without its arguments is not something to consent to.
 */
function subjectOf(args: Record<string, unknown>): string {
  return typeof args["command"] === "string" ? args["command"] : JSON.stringify(args);
}

export async function runInteractive(
  daemon: DaemonHandle,
  settings: Settings,
  workspace: string,
  local: boolean,
  label: string,
  io: Io,
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const approve = sessionApprover((q) => rl.question(q), io);

  io.err(BANNER(settings, workspace, local, label));

  let sessionId = await createSession(daemon, workspace);
  let seq = 0;

  try {
    for (;;) {
      const line = (await rl.question("[1m>[0m ")).trim();
      if (!line) continue;

      if (line.startsWith("/")) {
        // Session-scoped first, then the shared handler. Splitting them this
        // way keeps `dem` and any later shell answering the same words.
        if (line === "/session") {
          io.err(`${sessionId}
`);
          continue;
        }
        if (line === "/new") {
          sessionId = await createSession(daemon, workspace);
          seq = 0;
          io.err(`[2mnew session ${sessionId}[0m
`);
          continue;
        }

        const result = await runSessionCommand(line, {
          workspace,
          io,
          ask: (question: string) => rl.question(question),
        });
        if (result.exit) return 0;
        if (result.changed) {
          // The daemon was started with the old provider. Saying so is honest
          // and cheap; reconnecting mid-session is not, and pretending the
          // change took effect would be worse than either.
          io.err("[2mwritten - restart dem for it to take effect[0m\n");
        }
        continue;
      }

      const result = await runTurn(daemon, sessionId, line, io, approve, seq);
      seq = result.seq;
      io.err("\n");
    }
  } catch (err) {
    // A closed stdin (Ctrl-D, or a pipe ending) is an ordinary exit, not a
    // crash to report.
    if ((err as Error).message?.includes("closed")) return 0;
    throw err;
  } finally {
    rl.close();
  }
}
