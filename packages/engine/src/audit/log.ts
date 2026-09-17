import { NotImplemented } from "@dem/protocol";

/**
 * Decision/audit trail (invariants 17 and 20; tests SEC-014, RUN-006).
 *
 * Append-only JSONL plus a SQLite index. What is stored is the public case
 * for an answer — claims, evidence, verifier output, tool and permission
 * events. What is not stored is the model's hidden reasoning channel: we
 * cannot promise users we keep no scratchpad and then persist it.
 */

export interface AuditRecord {
  type: string;
  at: string;
  [key: string]: unknown;
}

/** Provenance captured per model call (SPEC section 15). */
export interface ProvenanceRecord {
  provider: string;
  model: string;
  modelSha256?: string;
  quantization?: string;
  runtime?: string;
  runtimeVersion?: string;
  chatTemplateHash?: string;
  promptHash: string;
  contextHash: string;
  evidenceHashes: string[];
  temperature?: number;
  topP?: number;
  seed?: number;
  contextSize?: number;
  startedAt: string;
  endedAt: string;
}

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
  read(decisionOrSession: string): Promise<AuditRecord[]>;
}

/**
 * Strip reasoning-channel content from a provider response before anything is
 * persisted or shown. Applied at the adapter boundary so no downstream module
 * has to remember (invariant 17).
 */
export function stripReasoningChannel(_raw: unknown): unknown {
  throw new NotImplemented("stripReasoningChannel", "SEC-014");
}

/** Field names providers use for hidden reasoning. Checked, not trusted. */
export const REASONING_FIELDS: readonly string[] = [
  "reasoning",
  "reasoning_content",
  "thinking",
  "thought",
  "scratchpad",
  "chain_of_thought",
  "internal",
];

export function openAuditLog(_dir: string): Promise<AuditLog> {
  throw new NotImplemented("openAuditLog", "RUN-004");
}
