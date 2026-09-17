import { NotImplemented } from "@dem/protocol";
import type { ContextBlock } from "@dem/protocol";

/**
 * Remote egress policy (invariants 1 and 2, test SEC-006).
 *
 * Reading a file and sending its contents to a remote provider are two
 * different permissions. The harness holds local file access open by default
 * precisely because egress is held closed.
 */

export interface EgressRequest {
  provider: string;
  blocks: readonly ContextBlock[];
}

export interface EgressApproval {
  approved: boolean;
  /** Blocks cleared for transmission, possibly redacted copies. */
  blocks: readonly ContextBlock[];
  reason: string;
}

/**
 * Throws PolicyViolation when no explicit egress approval covers these blocks.
 * File-read permission never satisfies this check.
 */
export function assertEgressApproved(
  _request: EgressRequest,
  _approvals: readonly EgressApproval[],
): void {
  throw new NotImplemented("assertEgressApproved", "SEC-006");
}
