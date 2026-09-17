import { NotImplemented } from "@dem/protocol";
import type { SessionId } from "@dem/protocol";

/**
 * Compaction (invariant 16, test RUN-005).
 *
 * The canonical transcript is append-only and is never rewritten. A checkpoint
 * is an additional artifact that the working context may be built from; if the
 * summary turns out to be wrong or lossy, the original is still there.
 */

export interface Checkpoint {
  sessionId: SessionId;
  /** Event seq this checkpoint summarises up to, exclusive. */
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

/** Writes a new checkpoint artifact. Does not touch the transcript. */
export function writeCheckpoint(
  _sessionId: SessionId,
  _throughSeq: number,
): Promise<Checkpoint> {
  throw new NotImplemented("writeCheckpoint", "RUN-005");
}

/** Working context = checkpoint + recent turns + retrieved evidence. */
export function buildWorkingContext(
  _checkpoint: Checkpoint,
  _recentTurnCount: number,
): Promise<string> {
  throw new NotImplemented("buildWorkingContext", "RUN-005");
}
