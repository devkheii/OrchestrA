import { CAP_TEXT_GENERATE, CAP_TEXT_REASON, CAP_TOOL_CALL } from "@dem/protocol";
import type {
  ModelEvent,
  ModelMessage,
  ModelRequest,
  Provider,
  ProviderHealth,
  RunContext,
} from "@dem/protocol";

/**
 * OpenAI-compatible provider: llama.cpp's server, a local gateway, or a hosted
 * API (plan 4.4).
 *
 * One adapter covers all three because they speak the same wire format. What
 * differs is whether the call leaves the machine, which is a policy question,
 * so `isLocal()` answers it explicitly rather than leaving the daemon to guess
 * from a URL.
 */

export interface OpenAICompatibleConfig {
  /** e.g. http://127.0.0.1:8080 for llama.cpp, or a hosted endpoint. */
  baseUrl: string;
  model: string;
  /** Resolved by the Secret Broker; never read from config by this adapter. */
  apiKey?: string;
  /** Extra headers some gateways require. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fields carrying a model-authored summary of its reasoning.
 *
 * Reasoning-capable local models (Qwen, DeepSeek and the like, served through
 * an OpenAI-compatible endpoint) put a summary here. It is surfaced as a
 * `rationale` event — labelled, never merged into the answer — because a
 * summary the model wrote to be read is a public rationale, not the hidden
 * chain-of-thought invariant 17 forbids keeping (SPEC §15.1).
 *
 * The separation is what makes that true. Concatenated into the answer, it
 * would be indistinguishable from one, and would have to be dropped.
 */
const REASONING_KEYS = [
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "thinking",
  "thought",
];

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    // Identifies the endpoint and model, never the credential: this string
    // lands in audit records and event payloads.
    this.id = `openai-compatible:${hostOf(config.baseUrl)}/${config.model}`;
  }

  capabilities(): readonly string[] {
    return [CAP_TEXT_GENERATE, CAP_TEXT_REASON, CAP_TOOL_CALL];
  }

  /**
   * Whether a call to this endpoint is egress at all (invariant 2). A local
   * llama.cpp server is not a third party; a hosted API is. Loopback only —
   * a LAN address is still another machine, and may be another person's.
   */
  isLocal(): boolean {
    const host = hostOf(this.config.baseUrl).split(":")[0] ?? "";
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${trimEnd(this.config.baseUrl)}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
      return res.ok
        ? { ok: true, detail: `${this.config.model} reachable` }
        : { ok: false, detail: `endpoint returned ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `unreachable: ${(err as Error).message}` };
    }
  }

  async *run(request: ModelRequest, context?: RunContext): AsyncIterable<ModelEvent> {
    const signal = context?.signal;

    let response: Response;
    try {
      response = await fetch(`${trimEnd(this.config.baseUrl)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers() },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map(toWireMessage),
          stream: true,
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      // Surfaced as an event, not thrown: the caller is iterating a stream and
      // a throw there unwinds a loop that may hold a session open.
      //
      // A bare "fetch failed" is what Node gives for a refused connection, and
      // it tells a user nothing they can act on. The common case by far is a
      // local model server that is not running, so the message says that and
      // names the address it tried.
      yield { type: "error", message: unreachable(err, this.config.baseUrl) };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: "error", message: `endpoint returned ${response.status}` };
      return;
    }

    let reason: "stop" | "length" | "cancelled" = "stop";

    // Did the server say it was done, or did it just stop talking?
    //
    // A local model server died mid-generation during the efficacy experiment:
    // it emitted 5,381 characters of reasoning, no answer, and closed the
    // connection with neither `[DONE]` nor a `finish_reason`. It then stayed
    // bound to its port and answered 57 more requests in under 200ms with
    // nothing in them. None of it raised, so all 57 read as successful empty
    // answers — which is a dead server's silence attributed to the model.
    let finished = false;

    // What was received before the stream stopped, so the two cases a user has
    // to tell apart — a server that died and a model with nothing to say —
    // look different in the error.
    let answerChars = 0;
    let rationaleChars = 0;
    // Tool arguments arrive as partial JSON across frames, so a call is only
    // whole once the stream ends. Emitting early would hand the loop a
    // half-parsed object it would have to guess at.
    const pending = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const payload of sseFrames(response.body, signal)) {
        if (payload === "[DONE]") {
          finished = true;
          break;
        }

        let frame: ChatFrame;
        try {
          frame = JSON.parse(payload) as ChatFrame;
        } catch {
          // Keepalives, comments and torn frames. Skipping one is right; the
          // rest of the answer is still worth delivering.
          continue;
        }

        const choice = frame.choices?.[0];
        if (!choice) continue;

        // Rationale first, so a consumer rendering in order shows the model's
        // reasoning before the conclusion it led to.
        const rationale = rationaleOf(choice.delta);
        if (rationale) {
          rationaleChars += rationale.length;
          yield { type: "rationale", text: rationale };
        }

        const text = contentOf(choice.delta);
        if (text) {
          answerChars += text.length;
          yield { type: "delta", text };
        }

        for (const part of choice.delta?.["tool_calls"] as WireToolCall[] | undefined ?? []) {
          const slot = pending.get(part.index) ?? { id: "", name: "", args: "" };
          if (part.id) slot.id = part.id;
          if (part.function?.name) slot.name = part.function.name;
          if (part.function?.arguments) slot.args += part.function.arguments;
          pending.set(part.index, slot);
        }

        if (choice.finish_reason) {
          // Some servers close after this without sending [DONE]; that is a
          // complete answer and refusing it would break working endpoints.
          finished = true;
          if (choice.finish_reason === "length") reason = "length";
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "error", message: `stream failed: ${(err as Error).message}` };
      return;
    }

    for (const [index, slot] of pending) {
      if (!slot.name) continue;
      let args: Record<string, unknown>;
      try {
        args = slot.args ? (JSON.parse(slot.args) as Record<string, unknown>) : {};
      } catch {
        // Malformed arguments are reported rather than guessed at. A tool call
        // run on a repaired guess is a side effect nobody asked for.
        yield {
          type: "error",
          message: `tool call ${slot.name} had unparseable arguments: ${slot.args.slice(0, 200)}`,
        };
        continue;
      }
      yield {
        type: "tool_call",
        call: { id: slot.id || `call_${index}`, name: slot.name, arguments: args },
      };
    }

    if (!finished && !signal?.aborted) {
      yield {
        type: "error",
        message:
          `the model server ended the stream without finishing it, after ` +
          `${answerChars} characters of answer and ${rationaleChars} of reasoning. ` +
          `It most likely died mid-generation — a configuration that loads and ` +
          `answers a short prompt can still run out of memory once the context fills.`,
      };
      return;
    }

    yield { type: "done", reason: signal?.aborted ? "cancelled" : reason };
  }

  private headers(): Record<string, string> {
    return {
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };
  }
}

interface WireToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** A tool result carries the id of the call it answers. */
function toWireMessage(message: ModelMessage): Record<string, unknown> {
  return message.role === "tool"
    ? { role: "tool", content: message.content, tool_call_id: message.toolCallId }
    : { role: message.role, content: message.content };
}

interface ChatFrame {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
}

/** Answer text only. Reasoning fields are read by `rationaleOf`, never here. */
function contentOf(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";
  const content = delta["content"];
  return typeof content === "string" ? content : "";
}

/** The model's own summary of its reasoning, if this endpoint returns one. */
function rationaleOf(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";
  for (const key of REASONING_KEYS) {
    const value = delta[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Parse an SSE body into `data:` payloads. */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        boundary = buffer.indexOf("\n");
      }
    }
  } finally {
    // Releases the socket on abort as well as on completion; without this an
    // aborted run leaks a connection per cancellation.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Turn a connection failure into something the user can act on.
 *
 * Node reports a refused connection as a bare "fetch failed", which names
 * neither what was being reached nor what to do. For a local-first harness the
 * overwhelmingly common cause is a model server that is not running.
 */
function unreachable(err: unknown, baseUrl: string): string {
  const message = (err as Error).message ?? String(err);
  const refused = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message);

  if (!refused) return `request failed: ${message}`;

  const host = hostOf(baseUrl);
  const isLoopback = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(host);

  return isLoopback
    ? `could not reach a model server at ${baseUrl}. Start one, for example:\n` +
        `  llama serve -m <model>.gguf --port ${host.split(":")[1] ?? "8080"}`
    : `could not reach ${baseUrl}: ${message}`;
}

function trimEnd(url: string): string {
  return url.replace(/\/+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
