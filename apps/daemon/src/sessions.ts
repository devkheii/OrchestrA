import { createHash } from "node:crypto";
import type { Provider, SessionEvent, SessionId } from "@dem/protocol";
import type { SessionStore } from "@dem/engine";

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
export async function runMessage(
  store: SessionStore,
  provider: Provider,
  id: SessionId,
  content: string,
  signal: AbortSignal,
): Promise<RunResult> {
  const now = () => new Date().toISOString();

  await store.append(id, {
    type: "message.received",
    sessionId: id,
    at: now(),
    role: "user",
    contentHash: hash(content),
  });

  await store.append(id, {
    type: "model.started",
    sessionId: id,
    at: now(),
    provider: provider.id,
    model: provider.id,
  });

  let reason: RunResult["reason"] = "stop";
  try {
    for await (const event of provider.run(
      { messages: [{ role: "user", content }] },
      { signal },
    )) {
      if (event.type === "rationale") {
        // Persisted like any other event, so what the user is shown and what the
        // record contains cannot drift apart (SPEC 15.1).
        await store.append(id, {
          type: "answer.rationale",
          sessionId: id,
          at: now(),
          text: event.text,
        });
      } else if (event.type === "delta") {
        await store.append(id, {
          type: "answer.delta",
          sessionId: id,
          at: now(),
          text: event.text,
        });
      } else if (event.type === "done") {
        reason = event.reason;
      } else {
        reason = "error";
        break;
      }
    }
  } catch {
    reason = "error";
  }

  if (reason === "cancelled") {
    await store.append(id, {
      type: "session.cancelled",
      sessionId: id,
      at: now(),
      reason: "client cancelled",
    });
    return { completed: false, reason };
  }

  await store.append(id, {
    type: "session.completed",
    sessionId: id,
    at: now(),
    status: reason === "error" ? "error" : "ok",
  });
  return { completed: true, reason };
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
