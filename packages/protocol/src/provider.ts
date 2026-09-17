/**
 * Provider contract (SPEC section 4).
 *
 * Core logic depends on capabilities and this interface, never on a model
 * name. That is what lets llama.cpp, a remote API and a fake all sit behind
 * the same call site.
 */

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on a tool result, linking it to the call it answers. */
  toolCallId?: string;
  /** Set on an assistant turn that requested tools. */
  toolCalls?: readonly ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Tools the model may request. Absent means text only. */
  tools?: readonly ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * A model-authored summary of its own reasoning, kept apart from the answer.
 *
 * Separate by construction, not by convention: once rationale is concatenated
 * into answer text there is no way to tell them apart afterwards, and from that
 * point it has to be treated as a raw reasoning channel (invariant 35).
 */
export type ModelEvent =
  | { type: "delta"; text: string }
  | { type: "rationale"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; reason: "stop" | "length" | "cancelled" }
  | { type: "error"; message: string };

/** A tool the model may call. Shape follows the OpenAI function-tool schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RunContext {
  /** Cancellation propagates here (SPEC section 23). */
  signal?: AbortSignal;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface Provider {
  readonly id: string;
  capabilities(): readonly string[];
  run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent>;
  health(): Promise<ProviderHealth>;
}
