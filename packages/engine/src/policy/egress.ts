import { PolicyViolation } from "@dem/protocol";
import type { ContextBlock } from "@dem/protocol";

/**
 * Remote egress policy (invariants 1 and 2, test SEC-006).
 *
 * Reading a file and sending its contents to a remote provider are two
 * different permissions. Conflating them is how a local-first tool quietly
 * stops being local-first: the agent already had read access, so the upload
 * looks like something it was already allowed to do.
 *
 * Approval is per provider and per block. Neither generalises on its own —
 * consent to show a file to one model is not consent to show it to another,
 * and consent to send one file is not consent to send the directory.
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
  /**
   * Provider this approval covers. Absent means the approval was recorded
   * without naming one, which covers nothing: an unscoped approval is treated
   * as a bug in the caller, not as a wildcard.
   */
  provider?: string;
}

export function assertEgressApproved(
  request: EgressRequest,
  approvals: readonly EgressApproval[],
): void {
  const relevant = approvals.filter(
    (a) => a.approved && a.provider !== undefined && a.provider === request.provider,
  );

  const cleared = new Set<string>();
  for (const approval of relevant) {
    for (const block of approval.blocks) cleared.add(block.id);
  }

  const withheld = request.blocks.filter((block) => !cleared.has(block.id));
  if (withheld.length === 0) return;

  throw new PolicyViolation(
    `remote egress to ${request.provider} not approved for ${withheld.length} block(s): ` +
      withheld.map((b) => `${b.id} (${b.origin})`).join(", "),
    2,
  );
}
