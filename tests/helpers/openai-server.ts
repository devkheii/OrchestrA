import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A minimal stand-in for an OpenAI-compatible endpoint: llama.cpp's server,
 * a local gateway, or the hosted API.
 *
 * Real ones are used for manual checks; this one is here so the adapter's
 * behaviour under cancellation, malformed frames and error responses is
 * exercised on every run rather than whenever someone remembers to start a
 * model.
 */

export interface FakeEndpoint {
  url: string;
  /** Requests received, so a test can assert on headers and body. */
  requests: Array<{ headers: NodeJS.Dict<string | string[]>; body: unknown }>;
  close(): Promise<void>;
}

export interface FakeEndpointOptions {
  /** SSE `data:` payloads to emit in order, as objects. */
  frames?: unknown[];
  /** Raw lines to emit verbatim, for malformed-frame cases. */
  rawLines?: string[];
  /** Respond with this status and body instead of streaming. */
  errorStatus?: number;
  /** Milliseconds between frames, so a test can cancel mid-stream. */
  frameDelayMs?: number;
  /**
   * Answer each request differently, for retry behaviour.
   *
   * Returns the options to use for that one request, so a test can make the
   * first attempt fail and the second succeed.
   */
  onRequest?: () => Partial<FakeEndpointOptions>;
}

export async function startFakeOpenAI(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
  const requests: FakeEndpoint["requests"] = [];

  const server: Server = createServer(async (req, res) => {
    requests.push({ headers: req.headers, body: await readBody(req) });

    // The path matters, or a test cannot tell a correct URL from a wrong one.
    // It could not: the adapter asked for /v1/v1/chat/completions against a
    // real Ollama and got a 404, while every test here passed, because this
    // stand-in answered whatever it was asked for.
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!/^\/v1\/(chat\/completions|models)$/.test(path)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no such path: ${path}` } }));
      return;
    }

    const perRequest = options.onRequest ? { ...options, ...options.onRequest() } : options;

    if (perRequest.errorStatus !== undefined) {
      res.writeHead(perRequest.errorStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream refused" } }));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const lines = perRequest.rawLines ?? [
      ...(perRequest.frames ?? []).map((f) => `data: ${JSON.stringify(f)}`),
      "data: [DONE]",
    ];

    for (const line of lines) {
      if (res.writableEnded || res.destroyed) return;
      res.write(line + "\n\n");
      if (perRequest.frameDelayMs) await sleep(perRequest.frameDelayMs);
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

/** A content delta in the shape OpenAI-compatible servers emit. */
export function delta(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

export function finish(reason: "stop" | "length"): unknown {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
