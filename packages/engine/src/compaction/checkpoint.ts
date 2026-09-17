import type { SessionEvent, SessionId } from "@dem/protocol";
import type { SessionStore } from "../session/store.js";

/**
 * Compaction (invariant 16, test RUN-005).
 *
 * A checkpoint is an additional artifact. The canonical transcript is not
 * rewritten, shortened or marked superseded — if the summary turns out lossy
 * or wrong, the original is still there to go back to, which is the whole
 * claim invariant 16 makes.
 *
 * The v0.1 checkpoint is derived structurally from the event log rather than
 * written by a model. It is therefore exact but shallow: it records what
 * happened, not what it meant. A model-written summary can be layered on later
 * without changing this contract, and keeping the deterministic one underneath
 * means a bad summary never becomes the only record.
 */

export interface Checkpoint {
  sessionId: SessionId;
  /** Event seq this checkpoint summarises up to, inclusive. */
  throughSeq: number;
  goal: string;
  decisions: string[];
  filesChanged: string[];
  completed: string[];
  pending: string[];
  errors: string[];
  constraints: string[];
  evidenceRefs: string[];
  memoryRefs: string[];
  createdAt: string;
}

/** Content classes that must never be summarised or compressed (SPEC 17). */
export const NEVER_COMPRESS: readonly string[] = [
  "system_policy",
  "code_diff",
  "verifier_fact",
  "evidence_id",
  "decision_id",
  "file_hash",
  "permission_state",
];

/**
 * Build and persist a checkpoint. Reads the transcript; never writes to it.
 */
export async function writeCheckpoint(
  store: SessionStore,
  sessionId: SessionId,
  throughSeq: number,
): Promise<Checkpoint> {
  const events = (await store.events(sessionId)).filter((e) => e.seq <= throughSeq);
  const checkpoint = summarise(sessionId, throughSeq, events);
  await store.saveCheckpoint(checkpoint);
  return checkpoint;
}

function summarise(
  sessionId: SessionId,
  throughSeq: number,
  events: readonly SessionEvent[],
): Checkpoint {
  const filesChanged = new Set<string>();
  const completed: string[] = [];
  const errors: string[] = [];

  for (const event of events) {
    if (event.type === "tool.finished") {
      if (event.ok) completed.push(event.tool);
      else errors.push(`${event.tool} failed`);
      if (event.artifactId) filesChanged.add(event.artifactId);
    }
    if (event.type === "session.completed" && event.status === "error") {
      errors.push("session ended in error");
    }
    if (event.type === "session.cancelled") errors.push(`cancelled: ${event.reason}`);
  }

  const firstMessage = events.find((e) => e.type === "message.received");

  return {
    sessionId,
    throughSeq,
    // The transcript holds the text; the checkpoint holds a reference to it,
    // so a secret redacted in one place is not re-exposed in the other.
    goal: firstMessage ? `message ${firstMessage.contentHash}` : "",
    decisions: [],
    filesChanged: [...filesChanged],
    completed,
    pending: [],
    errors,
    constraints: [],
    evidenceRefs: [],
    memoryRefs: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Working context = checkpoint + recent turns. The checkpoint stands in for
 * everything before `throughSeq`; the recent turns are passed through intact
 * because that is where the detail the model still needs actually lives.
 */
export async function buildWorkingContext(
  store: SessionStore,
  checkpoint: Checkpoint,
  recentTurnCount: number,
): Promise<string> {
  const all = await store.events(checkpoint.sessionId, checkpoint.throughSeq);
  const recent = all.slice(-recentTurnCount);

  return [
    `## checkpoint through seq ${checkpoint.throughSeq}`,
    `goal: ${checkpoint.goal}`,
    `completed: ${checkpoint.completed.join(", ") || "none"}`,
    `errors: ${checkpoint.errors.join(", ") || "none"}`,
    ``,
    `## recent`,
    ...recent.map((e) => `[${e.seq}] ${e.type}`),
  ].join("\n");
}
