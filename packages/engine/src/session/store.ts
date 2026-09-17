import { NotImplemented } from "@dem/protocol";
import type { SessionEvent, SessionEventInput, SessionId } from "@dem/protocol";

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

export function cancelRun(_targets: CancelTargets, _graceMs: number): Promise<void> {
  throw new NotImplemented("cancelRun", "RUN-001");
}
