import { NotImplemented } from "@dem/protocol";
import type { DecisionId } from "@dem/protocol";

/**
 * Replayable provenance (invariant 20, test RUN-006).
 *
 * The goal is not bitwise reproduction — local GPU inference does not promise
 * that even at a fixed seed. The goal is that someone can reconstruct what
 * went into a decision and check whether it still holds.
 */

export type ReconstructionStatus = "reconstructible" | "missing" | "changed";

export interface ReplayItem {
  item:
    | "model_fingerprint"
    | "provider_config"
    | "context_hash"
    | "evidence_hash"
    | "tools"
    | "verifiers"
    | "permission_policy"
    | "scheduler_inputs";
  status: ReconstructionStatus;
  detail?: string;
}

export interface ReplayReport {
  decisionId: DecisionId;
  items: ReplayItem[];
}

/**
 * Inspection only: never mutates the workspace, spends remote budget, or runs
 * a tool. Those are the properties RUN-006 asserts.
 */
export function replayDryRun(_decisionId: DecisionId): Promise<ReplayReport> {
  throw new NotImplemented("replayDryRun", "RUN-006");
}
