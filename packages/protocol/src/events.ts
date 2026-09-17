/**
 * Session event stream (SPEC section 3, plan 4.2).
 *
 * The daemon assigns `seq`; clients never invent ordering. This event contract
 * is what lets CLI, Web and Desktop be thin shells over one core.
 */

import type { SessionId } from "./ids.js";
import type { PermissionDecision, PermissionRequest } from "./policy.js";
import type { ToolCall } from "./provider.js";

export type SessionEventType =
  | "session.started"
  | "message.received"
  | "model.started"
  | "answer.delta"
  | "answer.rationale"
  | "tool.requested"
  | "tool.started"
  | "tool.finished"
  | "permission.requested"
  | "permission.resolved"
  | "permission.granted"
  | "session.completed"
  | "session.cancelled";

interface EventBase<T extends SessionEventType> {
  type: T;
  /** Monotonic per session, assigned by the daemon. */
  seq: number;
  sessionId: SessionId;
  at: string;
}

export type SessionEvent =
  | (EventBase<"session.started"> & { workspace: string; mode: string })
  // The text itself, not only its hash: the loop rebuilds the conversation
  // from this log, so a projection that cannot recover the prompt is not a
  // record of what happened.
  | (EventBase<"message.received"> & { role: "user"; contentHash: string; content?: string })
  | (EventBase<"model.started"> & { provider: string; model: string })
  | (EventBase<"answer.delta"> & { text: string })
  // Persisted, so the display path and the audit record cannot diverge
  // (SPEC 15.1). Shown labelled, never merged into the answer.
  | (EventBase<"answer.rationale"> & { text: string })
  // The call itself, not only its hash. Anthropic requires the assistant turn
  // to carry the tool_use block that a tool_result answers, and a log that
  // cannot reconstruct that cannot rebuild the conversation at all.
  | (EventBase<"tool.requested"> & { tool: string; argsHash: string; call?: ToolCall })
  | (EventBase<"tool.started"> & { tool: string })
  | (EventBase<"tool.finished"> & {
      tool: string;
      ok: boolean;
      artifactId?: string;
      /** Links the result to the call, so a provider can match them up. */
      toolCallId?: string;
      /** What the model is shown. Bounded and redacted before it gets here. */
      result?: string;
    })
  // Carries the call itself, so an approval arriving after a restart still
  // finds what it is approving.
  | (EventBase<"permission.requested"> & { request: PermissionRequest; call: ToolCall })
  | (EventBase<"permission.granted"> & { by: "user"; callId: string })
  | (EventBase<"permission.resolved"> & { decision: PermissionDecision })
  | (EventBase<"session.completed"> & { status: "ok" | "error" })
  | (EventBase<"session.cancelled"> & { reason: string });

export type TerminalStatus = "ok" | "error" | "CANCELLED";

/**
 * `Omit` over a union collapses to the keys the members share, which would
 * erase every event-specific field. Distributing keeps each variant intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a caller supplies it: the daemon assigns `seq`. */
export type SessionEventInput = DistributiveOmit<SessionEvent, "seq">;
