import Anthropic from "@anthropic-ai/sdk";
import { CAP_TEXT_GENERATE, CAP_TEXT_REASON, CAP_TOOL_CALL, CAP_VISION_ANALYZE } from "@dem/protocol";
import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  Provider,
  ProviderHealth,
  RunContext,
} from "@dem/protocol";

/**
 * Native Anthropic provider, through the official SDK.
 *
 * Distinct from the Claude Code adapters in what it is for. The CLI provider
 * is a text generator with its tools removed; the CLI agent is handed whole
 * tasks and brings its own everything. This is a Provider in the sense of SPEC
 * §4.1 — it answers a prompt while the harness keeps context, tools,
 * permission and audit — which is what a council member has to be.
 *
 * **This bills per request.** Unlike the CLI, which draws on a subscription's
 * rate-limit window, every call here costs money against an API key. That is
 * worth stating in the code as well as the docs, because the two adapters look
 * interchangeable from the outside and are not.
 *
 * The SDK's tool runner is deliberately not used, though the skill guidance
 * prefers it. It would run tools itself, inside the adapter — and invariant 36
 * puts every tool call through our permission broker, with the loop in the
 * daemon so approval survives a restart. A runner here would move the loop
 * into the wrong layer and take the broker out of the path.
 */

export interface AnthropicConfig {
  /** Defaults to claude-opus-5. */
  model?: string;
  /** Resolved by the Secret Broker. Falls back to ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Overridable so tests can point at a stand-in. */
  baseURL?: string;
  maxOutputTokens?: number;
  /**
   * Show the model's own summary of its reasoning. On by default: a summary
   * written to be read is a public rationale, and the harness surfaces it as a
   * labelled event rather than dropping it (SPEC §15.1, invariant 35).
   */
  showRationale?: boolean;
}

const DEFAULT_MODEL = "claude-opus-5";

export class AnthropicProvider implements Provider {
  readonly id: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicConfig = {}) {
    // Identifies the model, never the credential: this string lands in audit
    // records and event payloads.
    this.id = `anthropic:${config.model ?? DEFAULT_MODEL}`;
    this.client = new Anthropic({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
  }

  capabilities(): readonly string[] {
    return [CAP_TEXT_GENERATE, CAP_TEXT_REASON, CAP_TOOL_CALL, CAP_VISION_ANALYZE];
  }

  /** Always false. The API is not on this machine, whatever the key is. */
  isLocal(): boolean {
    return false;
  }

  async health(): Promise<ProviderHealth> {
    try {
      await this.client.models.retrieve(this.config.model ?? DEFAULT_MODEL);
      return { ok: true, detail: `${this.config.model ?? DEFAULT_MODEL} reachable` };
    } catch (err) {
      return { ok: false, detail: describe(err) };
    }
  }

  async *run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent> {
    const { system, messages } = splitSystem(request.messages);

    let stream;
    try {
      stream = this.client.messages.stream(
        {
          model: this.config.model ?? DEFAULT_MODEL,
          // Streaming, so a large ceiling does not risk an HTTP timeout.
          max_tokens: this.config.maxOutputTokens ?? 64_000,
          ...(system ? { system } : {}),
          messages,
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
          thinking: {
            type: "adaptive",
            // Default is omitted, which streams empty thinking blocks and
            // looks like a long pause. Asking for the summary is what makes a
            // rationale available at all on this provider.
            display: this.config.showRationale === false ? "omitted" : "summarized",
          },
        },
        context?.signal ? { signal: context.signal } : {},
      );
    } catch (err) {
      yield { type: "error", message: describe(err) };
      return;
    }

    // Tool inputs arrive as partial JSON across frames, so a call is whole only
    // once its block closes. Emitting early would hand the loop an object it
    // would have to guess at.
    const pending = new Map<number, { id: string; name: string; json: string }>();
    let reason: "stop" | "length" | "cancelled" = "stop";

    try {
      for await (const event of stream) {
        if (context?.signal?.aborted) break;

        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          pending.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        }

        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "delta", text: delta.text };
          } else if (delta.type === "thinking_delta") {
            // A summary the model wrote to be read: surfaced labelled and
            // separate, never merged into the answer (invariant 35).
            if (delta.thinking) yield { type: "rationale", text: delta.thinking };
          } else if (delta.type === "input_json_delta") {
            const slot = pending.get(event.index);
            if (slot) slot.json += delta.partial_json;
          }
        }

        if (event.type === "content_block_stop") {
          const slot = pending.get(event.index);
          if (slot) {
            pending.delete(event.index);
            const call = parseCall(slot);
            yield call.ok
              ? { type: "tool_call", call: call.value }
              : { type: "error", message: call.message };
          }
        }

        if (event.type === "message_delta" && event.delta.stop_reason === "max_tokens") {
          reason = "length";
        }
      }
    } catch (err) {
      if (context?.signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "error", message: describe(err) };
      return;
    }

    yield { type: "done", reason: context?.signal?.aborted ? "cancelled" : reason };
  }
}

/**
 * Anthropic takes the system prompt as its own parameter rather than a message,
 * so system turns are lifted out instead of being sent as a role the API does
 * not accept.
 */
function splitSystem(messages: readonly ModelMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      // A tool result is a user turn carrying a tool_result block, and it must
      // reference the call it answers — the API rejects one that does not.
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }

  return { system, messages: out };
}

function parseCall(slot: { id: string; name: string; json: string }):
  | { ok: true; value: { id: string; name: string; arguments: Record<string, unknown> } }
  | { ok: false; message: string } {
  try {
    return {
      ok: true,
      value: {
        id: slot.id,
        name: slot.name,
        // An empty block means a tool taking no arguments, not a broken one.
        arguments: slot.json ? (JSON.parse(slot.json) as Record<string, unknown>) : {},
      },
    };
  } catch {
    // Reported rather than repaired. A tool call run on a guessed input is a
    // side effect nobody asked for.
    return {
      ok: false,
      message: `tool call ${slot.name} had unparseable arguments: ${slot.json.slice(0, 200)}`,
    };
  }
}

/**
 * Typed first, message last. The SDK's error classes carry the distinction
 * between "retry this" and "this will never work", and a caller reading only
 * a string has to guess which it got.
 */
function describe(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "authentication failed: check the API key";
  if (err instanceof Anthropic.RateLimitError) return "rate limited; retry later";
  if (err instanceof Anthropic.NotFoundError) return `not found: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `could not reach the API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `api error ${err.status}: ${err.message}`;
  return (err as Error).message ?? String(err);
}
