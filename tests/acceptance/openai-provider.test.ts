import { describe, expect, it } from "vitest";
import type { ModelEvent } from "@dem/protocol";
import { OpenAICompatibleProvider } from "@dem/adapters";
import { delta, finish, startFakeOpenAI } from "../helpers/openai-server.js";

/**
 * The first real provider: llama.cpp's server, a local gateway, or a hosted
 * OpenAI-compatible API (plan 4.4).
 *
 * Also SEC-014 at its actual boundary. Invariant 17 says the audit trail holds
 * no hidden reasoning; the only way to keep that promise is to drop the
 * reasoning channel where it enters the system, because after that it is
 * indistinguishable from an answer.
 */

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const REQUEST = { messages: [{ role: "user" as const, content: "hello" }] };

describe("OpenAI-compatible provider: streaming", () => {
  it("yields content deltas in order and a terminal done", async () => {
    const server = await startFakeOpenAI({
      frames: [delta("Hel"), delta("lo"), finish("stop")],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const events = await collect(provider.run(REQUEST));

      const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      expect(text).toBe("Hello");
      expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    } finally {
      await server.close();
    }
  });

  it("reports a truncated answer as length, not as a clean stop", async () => {
    // A caller that cannot tell "finished" from "ran out of room" will treat a
    // half-written patch as complete.
    const server = await startFakeOpenAI({ frames: [delta("partial"), finish("length")] });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const events = await collect(provider.run(REQUEST));
      expect(events.at(-1)).toEqual({ type: "done", reason: "length" });
    } finally {
      await server.close();
    }
  });

  it("skips a malformed frame instead of failing the whole stream", async () => {
    const server = await startFakeOpenAI({
      rawLines: [
        `data: ${JSON.stringify(delta("good"))}`,
        "data: {not json",
        ": a comment line servers send as a keepalive",
        `data: ${JSON.stringify(delta(" parts"))}`,
        "data: [DONE]",
      ],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const events = await collect(provider.run(REQUEST));
      const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      expect(text).toBe("good parts");
    } finally {
      await server.close();
    }
  });

  it("stops when the caller aborts mid-stream", async () => {
    const server = await startFakeOpenAI({
      frames: [delta("a"), delta("b"), delta("c"), delta("d"), finish("stop")],
      frameDelayMs: 40,
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const abort = new AbortController();
      const seen: string[] = [];

      for await (const event of provider.run(REQUEST, { signal: abort.signal })) {
        if (event.type === "delta") {
          seen.push(event.text);
          if (seen.length === 2) abort.abort();
        }
      }

      expect(seen.length).toBeLessThan(4);
    } finally {
      await server.close();
    }
  });
});

describe("OpenAI-compatible provider: invariants 17 and 35 at the boundary", () => {
  it("keeps the reasoning channel out of the answer, as its own event", async () => {
    // Not dropped — a summary the model wrote to be read is a public rationale
    // (SPEC §15.1). What must never happen is the two arriving as one string,
    // after which they cannot be told apart. SEC-019 covers this in full.
    const server = await startFakeOpenAI({
      frames: [
        { choices: [{ delta: { reasoning_content: "the user probably means..." } }] },
        { choices: [{ delta: { content: "42", reasoning: "because 6x7" } }] },
        finish("stop"),
      ],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const events = await collect(provider.run(REQUEST));

      const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      const rationale = events.filter((e) => e.type === "rationale").map((e) => e.text).join("");

      expect(answer).toBe("42");
      expect(answer).not.toContain("probably means");
      expect(answer).not.toContain("6x7");
      expect(rationale).toContain("probably means");
    } finally {
      await server.close();
    }
  });
});

describe("OpenAI-compatible provider: failure and identity", () => {
  it("surfaces an upstream error as an event rather than throwing mid-loop", async () => {
    const server = await startFakeOpenAI({ errorStatus: 503 });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "test" });
      const events = await collect(provider.run(REQUEST));
      expect(events.at(-1)?.type).toBe("error");
    } finally {
      await server.close();
    }
  });

  it("reports health honestly when the endpoint is unreachable", async () => {
    const provider = new OpenAICompatibleProvider({
      // Reserved TEST-NET-1; nothing answers here.
      baseUrl: "http://192.0.2.1:9",
      model: "test",
      timeoutMs: 300,
    });
    const health = await provider.health();
    expect(health.ok).toBe(false);
  });

  it("sends the API key as a header and keeps it out of its own identity", async () => {
    const server = await startFakeOpenAI({ frames: [finish("stop")] });
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: server.url,
        model: "test",
        apiKey: "sk-should-not-appear",
      });
      await collect(provider.run(REQUEST));

      expect(server.requests[0]?.headers["authorization"]).toBe("Bearer sk-should-not-appear");
      // The id ends up in audit records and event payloads.
      expect(provider.id).not.toContain("sk-");
    } finally {
      await server.close();
    }
  });

  it("classifies a loopback endpoint as local and a public one as remote", () => {
    const local = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:8080", model: "m" });
    const alsoLocal = new OpenAICompatibleProvider({ baseUrl: "http://localhost:8080", model: "m" });
    const remote = new OpenAICompatibleProvider({ baseUrl: "https://api.example.com", model: "m" });

    // This decides whether a call is egress at all (invariant 2). A local
    // llama.cpp server is not a third party; an API endpoint is.
    expect(local.isLocal()).toBe(true);
    expect(alsoLocal.isLocal()).toBe(true);
    expect(remote.isLocal()).toBe(false);
  });
});

describe("OpenAI-compatible provider: a refused connection explains itself", () => {
  it("names the local server that is not running, and how to start one", async () => {
    // Node reports a refused connection as a bare "fetch failed", which tells
    // a user neither what was unreachable nor what to do about it. For a
    // local-first harness the cause is almost always a model server that was
    // never started.
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:1",
      model: "none",
    });
    const events = await collect(provider.run(REQUEST));
    const error = events.at(-1);

    expect(error?.type).toBe("error");
    const message = error?.type === "error" ? error.message : "";
    expect(message).toContain("127.0.0.1:1");
    expect(message).toContain("llama serve");
  });

  it("does not claim a local server is missing when the endpoint is remote", async () => {
    const provider = new OpenAICompatibleProvider({
      // Reserved TEST-NET-1; nothing answers.
      baseUrl: "http://192.0.2.1:9",
      model: "none",
    });
    const events = await collect(provider.run(REQUEST));
    const message = events.at(-1)?.type === "error" ? (events.at(-1) as { message: string }).message : "";
    expect(message).not.toContain("llama serve");
  });
});

describe("SEC-024: a stream that stops is not a stream that finished (invariant 45)", () => {
  /**
   * Found in the experiment, not by review. A local model server died
   * mid-generation: it emitted 5,381 characters of reasoning, produced no
   * answer, and closed the connection without `[DONE]` and without a
   * `finish_reason`. It then stayed bound to its port and answered 57 more
   * requests in under 200ms each with nothing in them.
   *
   * Nothing raised. Every one of those was recorded as a successful empty
   * answer, and the model would have been reported as getting 57 tasks wrong.
   *
   * A truncated stream is an infrastructure failure and has to read as one,
   * because the alternative is attributing a dead server's silence to the
   * model (invariant 41 draws the same line for a different fabrication).
   */
  it("reports an error when the connection closes before any finish reason", async () => {
    const endpoint = await startFakeOpenAI({
      rawLines: [`data: ${JSON.stringify(delta("def solve():"))}`],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: endpoint.url, model: "m" });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "hi" }] }));

      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(events.some((e) => e.type === "done" && e.reason === "stop")).toBe(false);
    } finally {
      await endpoint.close();
    }
  });

  it("names what it received, so a dead server is distinguishable from a quiet model", async () => {
    const endpoint = await startFakeOpenAI({ rawLines: [] });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: endpoint.url, model: "m" });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "hi" }] }));
      const error = events.find((e) => e.type === "error");

      expect(error).toBeDefined();
      expect((error as { message: string }).message).toMatch(/without|incomplete|ended/i);
    } finally {
      await endpoint.close();
    }
  });

  it("still accepts a stream that ends with [DONE] and no explicit finish_reason", async () => {
    // Some servers send [DONE] without ever setting finish_reason. That is a
    // complete answer, and refusing it would break working endpoints.
    const endpoint = await startFakeOpenAI({ frames: [delta("hello")] });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: endpoint.url, model: "m" });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "hi" }] }));

      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    } finally {
      await endpoint.close();
    }
  });

  it("still accepts a stream that ends on finish_reason without [DONE]", async () => {
    const endpoint = await startFakeOpenAI({
      rawLines: [
        `data: ${JSON.stringify(delta("hello"))}`,
        `data: ${JSON.stringify(finish("stop"))}`,
      ],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: endpoint.url, model: "m" });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "hi" }] }));

      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    } finally {
      await endpoint.close();
    }
  });
});

describe("A baseUrl that already names a version path", () => {
  /**
   * Found by using the product, not by a test.
   *
   * `dem setup` discovers a running Ollama and writes
   * `http://127.0.0.1:11434/v1`, which is what every provider's own
   * documentation tells you to configure. The adapter then appended `/v1`
   * again and asked for `/v1/v1/chat/completions`, so the setup wizard wrote a
   * configuration that could not work — the exact opposite of what it exists
   * for.
   *
   * The same bug occurred in the experiment runner and was fixed there first.
   * It was not looked for here, which is the argument for running the thing
   * rather than only its tests.
   */
  it("does not append a second /v1", async () => {
    const endpoint = await startFakeOpenAI({ frames: [delta("hi"), finish("stop")] });
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: `${endpoint.url}/v1`,
        model: "m",
      });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "x" }] }));

      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events).toContainEqual({ type: "delta", text: "hi" });
    } finally {
      await endpoint.close();
    }
  });

  it("still appends /v1 when the baseUrl omits it", async () => {
    const endpoint = await startFakeOpenAI({ frames: [delta("hi"), finish("stop")] });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: endpoint.url, model: "m" });
      const events = await collect(provider.run({ messages: [{ role: "user", content: "x" }] }));
      expect(events).toContainEqual({ type: "delta", text: "hi" });
    } finally {
      await endpoint.close();
    }
  });

  it("tolerates a trailing slash either way", async () => {
    for (const suffix of ["/", "/v1/"]) {
      const endpoint = await startFakeOpenAI({ frames: [delta("ok"), finish("stop")] });
      try {
        const provider = new OpenAICompatibleProvider({
          baseUrl: `${endpoint.url}${suffix}`,
          model: "m",
        });
        const events = await collect(provider.run({ messages: [{ role: "user", content: "x" }] }));
        expect(events).toContainEqual({ type: "delta", text: "ok" });
      } finally {
        await endpoint.close();
      }
    }
  });

  it("reports health against the same path it will actually use", async () => {
    const endpoint = await startFakeOpenAI({ frames: [] });
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: `${endpoint.url}/v1`,
        model: "m",
      });
      const health = await provider.health();
      expect(health.ok).toBe(true);
    } finally {
      await endpoint.close();
    }
  });
});
