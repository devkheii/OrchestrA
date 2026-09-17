import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
export function stripReasoningChannel(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripReasoningChannel);
  if (raw === null || typeof raw !== "object") return raw;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Matched recursively and case-insensitively: providers nest the reasoning
    // channel inside choices and messages, and the field name drifts between
    // versions. Dropping the key outright beats trying to sanitise its content.
    if (REASONING_FIELDS.includes(key.toLowerCase())) continue;
    out[key] = stripReasoningChannel(value);
  }
  return out;
}

/** Field names providers use for hidden reasoning. Checked, not trusted. */
export const REASONING_FIELDS: readonly string[] = [
  "reasoning",
  "reasoning_content",
  "thinking",
  "thought",
  "scratchpad",
  "chain_of_thought",
  "reasoning_details",
  "internal",
];

/**
 * Append-only JSONL on disk.
 *
 * A file rather than a table because the audit trail should outlive the schema
 * that indexed it, and should stay readable with `tail` when the daemon is the
 * thing being debugged. The SQLite index is built over this, never instead
 * of it.
 */
export async function openAuditLog(dir: string): Promise<AuditLog> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "audit.jsonl");

  return {
    async append(record: AuditRecord): Promise<void> {
      // Reasoning-channel content is stripped at the boundary so no caller has
      // to remember (invariant 17).
      const clean = stripReasoningChannel(record) as AuditRecord;
      await appendFile(file, JSON.stringify(clean) + "\n", "utf8");
    },

    async read(decisionOrSession: string): Promise<AuditRecord[]> {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }

      const out: AuditRecord[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record: AuditRecord;
        try {
          record = JSON.parse(line) as AuditRecord;
        } catch {
          // A torn final line from a crash mid-write. Skipping it is right:
          // the rest of the trail is still valid and still worth reading.
          continue;
        }
        if (
          record["decision_id"] === decisionOrSession ||
          record["session_id"] === decisionOrSession
        ) {
          out.push(record);
        }
      }
      return out;
    },
  };
}
