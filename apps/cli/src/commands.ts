import type { DaemonHandle, SessionEvent } from "@dem/protocol";
import {
  createSession,
  runTurn,
  type Approver,
  type Io,
  type PendingCall,
} from "./session-ui.js";

/**
 * One-shot and inspection commands.
 *
 * `run` shares the turn machinery with the interactive loop, so the two cannot
 * drift in what they render or how they ask for approval.
 */

export async function runOnce(
  daemon: DaemonHandle,
  prompt: string,
  workspace: string,
  io: Io,
): Promise<number> {
  const sessionId = await createSession(daemon, workspace);
  const result = await runTurn(daemon, sessionId, prompt, io, ttyApprover(io));

  // The session id is the handle for `dem log`, so it is always shown.
  io.err(`\nsession ${sessionId}\n`);
  return result.status === "completed" ? 0 : 1;
}

/**
 * Approval at a terminal.
 *
 * The exact command is printed, not a summary. A prompt reading "run a shell
 * command?" trains the user to say yes without looking, which turns every
 * later approval into a formality.
 *
 * With no TTY it declines rather than assuming: a pipe cannot consent, and
 * defaulting to yes would make every scripted run auto-approving.
 */
export function ttyApprover(io: Io): Approver {
  return async (pending: PendingCall) => {
    const detail =
      typeof pending.call.arguments["command"] === "string"
        ? pending.call.arguments["command"]
        : JSON.stringify(pending.call.arguments);

    io.err(`\n[1m${pending.call.name}[0m  ${detail}\n`);
    io.err(`[2m${pending.rule}[0m\n`);
    io.err("allow? [y/N] ");

    if (!process.stdin.isTTY) {
      io.err("\nno tty; declining\n");
      return false;
    }

    const answer = (await readLine()).trim().toLowerCase();
    io.err("\n");
    return answer === "y" || answer === "yes";
  };
}

export function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      resolve(chunk);
    });
  });
}

/**
 * What happened in a session.
 *
 * The CLI printed a session id and gave no way to use it, which made the id
 * decoration. This reads the same event log the agent loop rebuilds from, so
 * what is shown is what the harness acted on — not a separate summary that
 * could describe something else.
 */
export async function showLog(
  daemon: DaemonHandle,
  sessionId: string,
  io: Io,
): Promise<number> {
  const res = await fetch(`${daemon.url}/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });

  if (res.status === 404) {
    io.err(`no such session: ${sessionId}\n`);
    return 1;
  }

  const { events } = (await res.json()) as { events: SessionEvent[] };
  if (events.length === 0) {
    io.err(`session ${sessionId} has no events\n`);
    return 0;
  }

  for (const event of events) {
    const at = event.at.slice(11, 19);
    const line = describe(event);
    if (line) io.out(`${at}  ${line}\n`);
  }

  const answer = events
    .filter((e) => e.type === "answer.delta")
    .map((e) => e.text)
    .join("");
  if (answer) io.out(`\nanswer:\n${answer}\n`);

  return 0;
}

/** One line per event, or empty for the ones that are the content itself. */
function describe(event: SessionEvent): string {
  switch (event.type) {
    case "session.started":
      return `session started in ${event.workspace} (mode ${event.mode})`;
    case "message.received":
      return `user: ${(event.content ?? `<${event.contentHash}>`).slice(0, 120)}`;
    case "model.started":
      return `model ${event.provider}`;
    case "tool.requested":
      return `tool requested: ${event.tool}`;
    case "permission.requested":
      return `permission asked: ${event.request.action} on ${event.request.subject}`;
    case "permission.resolved":
      return `permission ${event.decision.outcome} — ${event.decision.rule}`;
    case "permission.granted":
      return `approved by ${event.by}`;
    case "tool.started":
      return `tool ${event.tool} started`;
    case "tool.finished":
      return `tool ${event.tool} ${event.ok ? "ok" : "failed"}`;
    case "session.completed":
      return `completed (${event.status})`;
    case "session.cancelled":
      return `cancelled: ${event.reason}`;
    default:
      // answer.delta and answer.rationale are the content, printed below.
      return "";
  }
}
