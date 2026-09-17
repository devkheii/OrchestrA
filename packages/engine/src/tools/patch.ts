import { NotImplemented } from "@dem/protocol";

/**
 * Structured patching (invariant 26, test RUN-003).
 *
 * v0.1 exposes no unrestricted `write`. New files are created through a patch
 * so that every mutation arrives as a reviewable, auditable diff, and so the
 * expected-hash check has something to compare against.
 */

export type PatchOp =
  | { kind: "create"; path: string; content: string }
  | { kind: "update"; path: string; expectedHash: string; hunks: string }
  | { kind: "delete"; path: string; expectedHash: string };

export interface PatchResult {
  path: string;
  applied: boolean;
  newHash: string;
}

/**
 * Apply a patch under optimistic concurrency. An `update` or `delete` whose
 * `expectedHash` no longer matches the file on disk throws StaleWrite rather
 * than overwriting whatever arrived in between.
 */
export function applyPatch(
  _workspaceRoot: string,
  _ops: readonly PatchOp[],
): Promise<PatchResult[]> {
  throw new NotImplemented("applyPatch", "RUN-003");
}

export function hashFile(_absolutePath: string): Promise<string> {
  throw new NotImplemented("hashFile", "RUN-003");
}
