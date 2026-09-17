import { createHash } from "node:crypto";
import type { SessionEvent, SessionId } from "@dem/protocol";
import type { SessionStore } from "@dem/engine";
import { advanceRun, type LoopDeps, type RunOutcome } from "./agent-loop.js";

/**
 * Session lifecycle over the API (plan 4.2, acceptance in tests/acceptance).
 *
 * Every state transition becomes an event before anything else observes it,
 * so the log is the account of what happened rather than a summary written
 * afterwards. `seq` comes from the store, never from a client.
 */

export interface RunResult {
  completed: boolean;
  reason: "stop" | "length" | "cancelled" | "error";
}

export async function createSession(store: SessionStore, workspace: string) {
  const session = await store.create(workspace);
  await store.append(session.id, {
    type: "session.started",
    sessionId: session.id,
    at: new Date().toISOString(),
    workspace,
    // v0.1 ships no sandbox adapter, so ASK is both default and ceiling
    // (SPEC section 19.1).
    mode: "ASK",
  });
  return session;
}

/**
 * Handle one user message: record it, stream the provider's answer into the
 * log, and close the session.
 *
 * The answer is persisted chunk by chunk rather than assembled and written at
 * the end. A crash mid-generation then leaves a partial, honest transcript
 * instead of nothing at all.
 */
/**
 * Record the user's message, then hand control to the agent loop.
 *
 * The message text is stored alongside its hash because the loop rebuilds the
 * conversation from this log. A record that cannot reconstruct the prompt is a
 * record of a session having happened, not of what happened in it.
 */
export async function runMessage(
  store: SessionStore,
  deps: Omit<LoopDeps, "store">,
  id: SessionId,
  content: string,
): Promise<RunOutcome> {
  await store.append(id, {
    type: "message.received",
    sessionId: id,
    at: new Date().toISOString(),
    role: "user",
    contentHash: hash(content),
    content,
  });

  return advanceRun({ ...deps, store }, id);
}

/**
 * Record the user's answer to a pending approval and continue.
 *
 * Granting is a separate event from the decision that asked for it, so the log
 * shows both what the broker said and what the user then chose. A single
 * mutated record would lose the distinction between "allowed" and "allowed
 * because someone said so".
 */
export async function approvePending(
  store: SessionStore,
  deps: Omit<LoopDeps, "store">,
  id: SessionId,
  callId: string,
): Promise<RunOutcome> {
  await store.append(id, {
    type: "permission.granted",
    sessionId: id,
    at: new Date().toISOString(),
    by: "user",
    callId,
  });

  return advanceRun({ ...deps, store }, id);
}

export async function readEvents(
  store: SessionStore,
  id: SessionId,
  sinceSeq: number,
): Promise<SessionEvent[]> {
  return store.events(id, sinceSeq);
}

/**
 * Content is hashed, not copied, into the event row. The canonical text
 * already lives in the transcript; duplicating it here would mean redacting
 * the same secret in two places and eventually missing one.
 */
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
