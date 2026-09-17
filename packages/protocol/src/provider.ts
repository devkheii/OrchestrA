/**
 * Provider contract (SPEC section 4).
 *
 * Core logic depends on capabilities and this interface, never on a model
 * name. That is what lets llama.cpp, a remote API and a fake all sit behind
 * the same call site.
 */

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
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
  | { type: "done"; reason: "stop" | "length" | "cancelled" }
  | { type: "error"; message: string };

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
