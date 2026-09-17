import type { DaemonHandle, SessionEvent } from "@dem/protocol";

/**
 * One turn of a session, rendered.
 *
 * Extracted from the CLI so the same code serves a one-shot `dem run` and the
 * interactive loop, and so the approval prompt is injectable — a terminal
 * prompt cannot be exercised by a test, and an approval path that is never
 * tested is the one place that should not be.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface PendingCall {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  rule: string;
}

export interface RunOutcome {
  status: string;
  detail?: string;
  pending?: PendingCall;
}

/** Answers one approval. Returns false to decline and stop the turn. */
export type Approver = (pending: PendingCall) => Promise<boolean>;

export interface TurnResult {
  status: string;
  /** Event sequence rendered so far, so the next turn does not repeat it. */
  seq: number;
}

export async function runTurn(
  daemon: DaemonHandle,
  sessionId: string,
  prompt: string,
  io: Io,
  approve: Approver,
  fromSeq = 0,
): Promise<TurnResult> {
  const headers = {
    authorization: `Bearer ${daemon.token}`,
    "content-type": "application/json",
  };

  let outcome = (await (
    await fetch(`${daemon.url}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: prompt }),
    })
  ).json()) as RunOutcome;

  let seq = fromSeq;

  // The run stops at each approval rather than queueing them, so the user
  // answers one concrete command at a time instead of skimming a batch. Work
  // already done is shown first, so the decision is made with it in view.
  while (outcome.status === "awaiting_approval" && outcome.pending) {
    seq = await renderSince(daemon, sessionId, io, seq);

    if (!(await approve(outcome.pending))) {
      io.err("declined; stopping here\n");
      return { status: "declined", seq };
    }

    outcome = (await (
      await fetch(`${daemon.url}/sessions/${sessionId}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ callId: outcome.pending.call.id }),
      })
    ).json()) as RunOutcome;
  }

  seq = await renderSince(daemon, sessionId, io, seq);

  // Any unresolved outcome explains itself. The guard against narrated tool
  // use is only useful if the user is told why the run stopped — otherwise
  // they see the narration, no answer, and no reason.
  if (outcome.detail && outcome.status !== "completed") {
    io.err(`\n[1m${outcome.status}[0m: ${outcome.detail}\n`);
  }

  return { status: outcome.status, seq };
}

/**
 * Render everything since `from`, in log order.
 *
 * Rationale goes to stderr, dimmed; the answer goes to stdout. The separation
 * the event stream keeps is only worth having if the display keeps it too — a
 * pipe should receive the answer and nothing else.
 */
export async function renderSince(
  daemon: DaemonHandle,
  sessionId: string,
  io: Io,
  from: number,
): Promise<number> {
  const res = await fetch(`${daemon.url}/sessions/${sessionId}/events?since=${from}`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const { events } = (await res.json()) as { events: SessionEvent[] };

  let rationale = "";
  let answer = "";

  for (const event of events) {
    if (event.type === "answer.rationale") rationale += event.text;
    else if (event.type === "answer.delta") answer += event.text;
    else if (event.type === "tool.finished") {
      io.err(`[2m● ${event.tool}${event.ok ? "" : " (failed)"}[0m\n`);
    }
  }

  if (rationale) {
    io.err("[2m┌ reasoning[0m\n");
    for (const line of rationale.split("\n")) io.err(`[2m│ ${line}[0m\n`);
    io.err("[2m└[0m\n");
  }

  if (answer) io.out(answer + "\n");

  return events.at(-1)?.seq ?? from;
}

export async function createSession(daemon: DaemonHandle, workspace: string): Promise<string> {
  const res = await fetch(`${daemon.url}/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspace }),
  });
  return ((await res.json()) as { id: string }).id;
}
