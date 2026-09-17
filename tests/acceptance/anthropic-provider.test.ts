import { describe, expect, it } from "vitest";
import type { ModelEvent } from "@dem/protocol";
import { AnthropicProvider } from "@dem/adapters";
import {
  messageStart,
  messageStop,
  startFakeAnthropic,
  textBlock,
  thinkingBlock,
  toolBlock,
} from "../helpers/anthropic-server.js";

/**
 * Native Anthropic provider.
 *
 * Run against a stand-in. The real endpoint bills per request, so a suite that
 * called it would be one nobody ran before committing — and the properties
 * worth testing here (thinking separation, tool-input accumulation,
 * cancellation, error mapping) do not need a real model to exercise.
 */

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const textOf = (events: ModelEvent[]) =>
  events.filter((e) => e.type === "delta").map((e) => e.text).join("");
const rationaleOf = (events: ModelEvent[]) =>
  events.filter((e) => e.type === "rationale").map((e) => e.text).join("");

const ASK = { messages: [{ role: "user" as const, content: "hello" }] };

function provider(url: string, extra = {}) {
  return new AnthropicProvider({ baseURL: url, apiKey: "sk-test", model: "fake", ...extra });
}

describe("Anthropic provider: streaming", () => {
  it("streams text and ends with a terminal done", async () => {
    const server = await startFakeAnthropic({
      frames: [messageStart(), ...textBlock(0, ["Hel", "lo"]), ...messageStop()],
    });
    try {
      const events = await collect(provider(server.url).run(ASK));
      expect(textOf(events)).toBe("Hello");
      expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    } finally {
      await server.close();
    }
  });

  it("reports a truncated answer as length, not a clean stop", async () => {
    const server = await startFakeAnthropic({
      frames: [messageStart(), ...textBlock(0, ["cut"]), ...messageStop("max_tokens")],
    });
    try {
      const events = await collect(provider(server.url).run(ASK));
      expect(events.at(-1)).toEqual({ type: "done", reason: "length" });
    } finally {
      await server.close();
    }
  });
});

describe("Anthropic provider: rationale stays separate", () => {
  it("emits thinking as rationale, never as answer text", async () => {
    const server = await startFakeAnthropic({
      frames: [
        messageStart(),
        ...thinkingBlock(0, "weighing two readings of the question"),
        ...textBlock(1, ["The answer is 42."]),
        ...messageStop(),
      ],
    });
    try {
      const events = await collect(provider(server.url).run(ASK));

      expect(textOf(events)).toBe("The answer is 42.");
      expect(textOf(events)).not.toContain("weighing");
      expect(rationaleOf(events)).toContain("weighing two readings");
    } finally {
      await server.close();
    }
  });

  it("asks for a summary by default, since omitted is the API default", async () => {
    // Without this the stream carries empty thinking blocks and the user sees
    // a long pause where a rationale could have been.
    const server = await startFakeAnthropic({ frames: [messageStart(), ...messageStop()] });
    try {
      await collect(provider(server.url).run(ASK));
      const thinking = server.requests[0]?.body["thinking"] as Record<string, string>;
      expect(thinking).toMatchObject({ type: "adaptive", display: "summarized" });
    } finally {
      await server.close();
    }
  });

  it("can be told not to, for a caller that wants none", async () => {
    const server = await startFakeAnthropic({ frames: [messageStart(), ...messageStop()] });
    try {
      await collect(provider(server.url, { showRationale: false }).run(ASK));
      const thinking = server.requests[0]?.body["thinking"] as Record<string, string>;
      expect(thinking["display"]).toBe("omitted");
    } finally {
      await server.close();
    }
  });
});

describe("Anthropic provider: tool calls", () => {
  it("assembles a call whose arguments arrived across frames", async () => {
    const server = await startFakeAnthropic({
      frames: [
        messageStart(),
        ...toolBlock(0, "toolu_1", "read", ['{"pa', 'th": "a', '.txt"}']),
        ...messageStop("tool_use"),
      ],
    });
    try {
      const events = await collect(
        provider(server.url).run({
          ...ASK,
          tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
        }),
      );

      const call = events.find((e) => e.type === "tool_call");
      expect(call).toEqual({
        type: "tool_call",
        call: { id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
      });
    } finally {
      await server.close();
    }
  });

  it("treats an empty input block as a tool taking no arguments", async () => {
    const server = await startFakeAnthropic({
      frames: [messageStart(), ...toolBlock(0, "toolu_2", "now", []), ...messageStop("tool_use")],
    });
    try {
      const events = await collect(provider(server.url).run(ASK));
      const call = events.find((e) => e.type === "tool_call");
      expect(call?.type === "tool_call" && call.call.arguments).toEqual({});
    } finally {
      await server.close();
    }
  });

  it("reports unparseable arguments rather than guessing at them", async () => {
    // A tool run on a repaired guess is a side effect nobody asked for.
    const server = await startFakeAnthropic({
      frames: [
        messageStart(),
        ...toolBlock(0, "toolu_3", "patch", ['{"path": "a.txt", "conte']),
        ...messageStop("tool_use"),
      ],
    });
    try {
      const events = await collect(provider(server.url).run(ASK));
      expect(events.some((e) => e.type === "tool_call")).toBe(false);
      expect(events.some((e) => e.type === "error")).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("Anthropic provider: request shape", () => {
  it("lifts system turns into the system parameter, not a message role", async () => {
    // The API does not accept a system role in `messages`; sending one is a 400.
    const server = await startFakeAnthropic({ frames: [messageStart(), ...messageStop()] });
    try {
      await collect(
        provider(server.url).run({
          messages: [
            { role: "system", content: "be terse" },
            { role: "user", content: "hi" },
          ],
        }),
      );

      const body = server.requests[0]?.body;
      expect(body?.["system"]).toBe("be terse");
      const messages = body?.["messages"] as Array<{ role: string }>;
      expect(messages.every((m) => m.role !== "system")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("pairs a tool result with the call it answers", async () => {
    // A tool_result with no matching tool_use in the preceding assistant turn
    // is rejected outright, so the projection has to carry both.
    const server = await startFakeAnthropic({ frames: [messageStart(), ...messageStop()] });
    try {
      await collect(
        provider(server.url).run({
          messages: [
            { role: "user", content: "read it" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "toolu_9", name: "read", arguments: { path: "a.txt" } }],
            },
            { role: "tool", content: "file contents", toolCallId: "toolu_9" },
          ],
        }),
      );

      const messages = server.requests[0]?.body["messages"] as Array<{
        role: string;
        content: Array<{ type: string; id?: string; tool_use_id?: string }>;
      }>;

      const assistant = messages.find((m) => m.role === "assistant");
      const use = assistant?.content.find((b) => b.type === "tool_use");
      const result = messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === "tool_result");

      expect(use?.id).toBe("toolu_9");
      expect(result?.tool_use_id).toBe("toolu_9");
    } finally {
      await server.close();
    }
  });

  it("sends the key as a header and keeps it out of its own identity", async () => {
    const server = await startFakeAnthropic({ frames: [messageStart(), ...messageStop()] });
    try {
      const p = provider(server.url, { apiKey: "sk-should-not-appear" });
      await collect(p.run(ASK));

      expect(server.requests[0]?.headers["x-api-key"]).toBe("sk-should-not-appear");
      expect(p.id).not.toContain("sk-");
    } finally {
      await server.close();
    }
  });

  it("is never local, whatever the key is", () => {
    expect(new AnthropicProvider({ apiKey: "sk-x" }).isLocal()).toBe(false);
  });
});

describe("Anthropic provider: failure", () => {
  it("maps an upstream error to an event rather than throwing mid-loop", async () => {
    const server = await startFakeAnthropic({ errorStatus: 500 });
    try {
      const events = await collect(provider(server.url).run(ASK));
      expect(events.at(-1)?.type).toBe("error");
    } finally {
      await server.close();
    }
  });

  it("names an authentication failure as one, not as a generic error", async () => {
    // "api error 401" tells a user nothing they can act on.
    const server = await startFakeAnthropic({ errorStatus: 401 });
    try {
      const events = await collect(provider(server.url).run(ASK));
      const error = events.at(-1);
      expect(error?.type === "error" && error.message).toContain("authentication");
    } finally {
      await server.close();
    }
  });

  it("reports an unreachable endpoint through health rather than throwing", async () => {
    const p = new AnthropicProvider({ baseURL: "http://192.0.2.1:9", apiKey: "sk-x" });
    const health = await p.health();
    expect(health.ok).toBe(false);
  });
});
