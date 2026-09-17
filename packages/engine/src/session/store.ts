import { killProcessTree } from "../runtime/kill.js";
import type { TerminalManager } from "../tools/terminal.js";
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
  /** Terminal manager owning the PTYs below. */
  terminals?: TerminalManager;
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

  // PTYs are signalled alongside the plain processes rather than after them,
  // so the grace period is shared instead of serialised.
  //
  // A terminal that already exited on its own is not an error — it is the
  // outcome we wanted.
  const ptyExits: Array<Promise<unknown>> = [];
  for (const ptyId of targets.ptyIds) {
    const session = targets.terminals?.get(ptyId);
    if (!session) continue;
    ptyExits.push(session.exited);
    // The PTY's own process tree, not just the shell: a shell that spawned a
    // build and was killed leaves the build running otherwise.
    killProcessTree(session.pid);
    session.kill();
  }

  // Returning before the processes are actually gone would let a caller delete
  // the workspace, or report CANCELLED, while a child is still writing to it.
  // That makes the audit trail wrong at the moment it matters most.
  await Promise.all([
    waitForExit(targets.pids, graceMs),
    withDeadline(Promise.all(ptyExits), graceMs),
  ]);
}

/** Resolve when `promise` settles or the deadline passes, whichever is first. */
function withDeadline(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
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
