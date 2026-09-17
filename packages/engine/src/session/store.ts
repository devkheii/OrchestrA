import { NotImplemented } from "@dem/protocol";
import { killProcessTree } from "../runtime/kill.js";
import type { SessionEvent, SessionEventInput, SessionId } from "@dem/protocol";
import type { Checkpoint } from "../compaction/checkpoint.js";

/**
 * Session persistence (test RUN-004) and cancellation (invariant 27,
 * test RUN-001).
 *
 * Sessions survive a daemon restart because the event log is the state, not a
 * cache of it. SQLite in WAL mode.
 */

export interface SessionRecord {
  id: SessionId;
  workspace: string;
  createdAt: string;
  status: "active" | "completed" | "cancelled" | "error";
}

export interface SessionStore {
  create(workspace: string): Promise<SessionRecord>;
  get(id: SessionId): Promise<SessionRecord | null>;
  /** Daemon assigns `seq`; callers never supply it. */
  append(id: SessionId, event: SessionEventInput): Promise<SessionEvent>;
  events(id: SessionId, sinceSeq?: number): Promise<SessionEvent[]>;
  /** Persist a compaction checkpoint. Never touches the event table. */
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  /** Most recent checkpoint for a session, or null. */
  latestCheckpoint(id: SessionId): Promise<Checkpoint | null>;
  /** Releases the database handle. Safe to call more than once. */
  close(): Promise<void>;
}

export { openSessionStore } from "./sqlite-store.js";

/**
 * Cancellation cascade (SPEC section 23). Graceful stop, bounded grace
 * period, then hard kill of the process tree; PTYs closed; audit finalised
 * as CANCELLED. An orphaned subprocess after cancel is the failure RUN-001
 * exists to catch.
 */
export interface CancelTargets {
  /** Child process group/tree roots started by this run. */
  pids: number[];
  ptyIds: string[];
  abort: AbortController;
}

export async function cancelRun(targets: CancelTargets, graceMs: number): Promise<void> {
  // Aborted first, so in-flight provider calls, tool loops and council rounds
  // stop queueing more work while the processes are being torn down.
  targets.abort.abort();

  for (const pid of targets.pids) killProcessTree(pid);

  // Returning before the processes are actually gone would let a caller delete
  // the workspace, or report CANCELLED, while a child is still writing to it.
  await waitForExit(targets.pids, graceMs);

  // PTY handles close after their processes, so a half-dead terminal is not
  // left holding the session open. No PTY backend ships in v0.1.
  if (targets.ptyIds.length > 0) {
    throw new NotImplemented("PTY cleanup on cancel", "RUN-001");
  }
}

/** Poll until every pid is gone, or the grace period expires. */
async function waitForExit(pids: readonly number[], graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;

  for (;;) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0 || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 probes for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
