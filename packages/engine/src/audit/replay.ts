import type { DecisionId } from "@dem/protocol";
import type { AuditLog, AuditRecord } from "./log.js";

/**
 * Replayable provenance (invariant 20, test RUN-006).
 *
 * The goal is not bitwise reproduction. Local GPU inference does not promise
 * identical output even at a fixed seed, and a system that claimed otherwise
 * would be lying in the one place it must not. What is promised is that
 * someone can see what went into a decision and check whether it still holds.
 *
 * Absent evidence reports as `missing`, never as `reconstructible`. A replay
 * report that flatters an unreproducible decision is worse than no report:
 * it converts a gap into false assurance.
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

interface Provenance {
  provider?: string;
  model?: string;
  modelSha256?: string;
  promptHash?: string;
  contextHash?: string;
  evidenceHashes?: string[];
}

/**
 * Inspection only: never mutates the workspace, spends remote budget, or runs
 * a tool. Those are the properties RUN-006 asserts, and they are what make it
 * safe to run against a decision from months ago.
 */
export async function replayDryRun(log: AuditLog, decisionId: string): Promise<ReplayReport> {
  const records = await log.read(decisionId);
  const merged = mergeRecords(records);

  const provenance = (merged["provenance"] ?? {}) as Provenance;

  const item = (
    name: ReplayItem["item"],
    present: boolean,
    detail: string,
  ): ReplayItem =>
    present
      ? { item: name, status: "reconstructible", detail }
      : { item: name, status: "missing", detail: `not recorded: ${detail}` };

  return {
    decisionId: decisionId as DecisionId,
    items: [
      item("model_fingerprint", Boolean(provenance.model), "provider/model identity"),
      item("provider_config", Boolean(provenance.provider), "provider configuration"),
      item("context_hash", Boolean(provenance.contextHash ?? provenance.promptHash), "context snapshot hash"),
      item("evidence_hash", (provenance.evidenceHashes?.length ?? 0) > 0, "evidence hashes"),
      item("tools", Array.isArray(merged["tools"]), "tool references"),
      item("verifiers", Array.isArray(merged["verifiers"]), "verifier references"),
      item("permission_policy", merged["permissionPolicy"] !== undefined, "permission policy"),
      // Scheduler inputs arrive with the orchestrator in v0.3. Until then the
      // honest status is missing, not an exemption.
      item("scheduler_inputs", merged["schedulerInputs"] !== undefined, "scheduling inputs"),
    ],
  };
}

/** Later records win, so a decision amended mid-run reports its final state. */
function mergeRecords(records: readonly AuditRecord[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const record of records) Object.assign(merged, record);
  return merged;
}
