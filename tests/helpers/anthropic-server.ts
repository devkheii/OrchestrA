import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A stand-in for the Anthropic Messages API.
 *
 * The real endpoint bills per request, so the adapter's behaviour — thinking
 * separation, tool-input accumulation, cancellation, error mapping — is
 * exercised here on every run. A suite that charged money would be a suite
 * nobody ran before committing.
 *
 * Frames are the SSE events the API emits, in the order it emits them.
 */

export interface FakeAnthropic {
  url: string;
  requests: Array<{ headers: NodeJS.Dict<string | string[]>; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export interface FakeAnthropicOptions {
  frames?: unknown[];
  errorStatus?: number;
  frameDelayMs?: number;
}

export async function startFakeAnthropic(
  options: FakeAnthropicOptions = {},
): Promise<FakeAnthropic> {
  const requests: FakeAnthropic["requests"] = [];

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ headers: req.headers, body });

    if (options.errorStatus !== undefined) {
      res.writeHead(options.errorStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "nope" } }));
      return;
    }

    // The SDK probes /v1/models for health checks.
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fake-model", display_name: "Fake" }));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    for (const frame of options.frames ?? []) {
      if (res.writableEnded || res.destroyed) return;
      const event = frame as { type: string };
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      if (options.frameDelayMs) await sleep(options.frameDelayMs);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* Frame builders, in the shapes the API emits. */

export const messageStart = () => ({
  type: "message_start",
  message: {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

export const textBlock = (index: number, chunks: readonly string[]) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...chunks.map((text) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  })),
  { type: "content_block_stop", index },
];

export const thinkingBlock = (index: number, text: string) => [
  { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
  { type: "content_block_stop", index },
];

export const toolBlock = (index: number, id: string, name: string, jsonChunks: readonly string[]) => [
  { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
  ...jsonChunks.map((partial_json) => ({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  })),
  { type: "content_block_stop", index },
];

export const messageStop = (stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn") => [
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
