import { CAP_TEXT_GENERATE, CAP_TEXT_REASON, CAP_TOOL_CALL } from "@dem/protocol";
import type {
  ModelEvent,
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
 * Fields carrying the model's hidden reasoning. Dropped here, at the edge,
 * because once this text is mixed into an answer it cannot be told apart from
 * one (invariant 17).
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
          messages: request.messages,
          stream: true,
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
      yield { type: "error", message: `request failed: ${(err as Error).message}` };
      return;
    }

    if (!response.ok || !response.body) {
      yield { type: "error", message: `endpoint returned ${response.status}` };
      return;
    }

    let reason: "stop" | "length" | "cancelled" = "stop";

    try {
      for await (const payload of sseFrames(response.body, signal)) {
        if (payload === "[DONE]") break;

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

        const text = contentOf(choice.delta);
        if (text) yield { type: "delta", text };

        if (choice.finish_reason === "length") reason = "length";
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "error", message: `stream failed: ${(err as Error).message}` };
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

interface ChatFrame {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
}

/**
 * Answer text only. A reasoning field is not concatenated into the answer,
 * and not carried alongside it either — there is no downstream consumer for
 * it that would not eventually persist it.
 */
function contentOf(delta: Record<string, unknown> | undefined): string {
  if (!delta) return "";
  for (const key of REASONING_KEYS) {
    if (key in delta) delete delta[key];
  }
  const content = delta["content"];
  return typeof content === "string" ? content : "";
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
