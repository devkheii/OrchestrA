import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CAP_TEXT_GENERATE, CAP_TOOL_CALL } from "@dem/protocol";
import type { ModelEvent, ModelRequest, Provider, ProviderHealth } from "@dem/protocol";
import { startDaemon } from "@dem/daemon";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-022 — invariant 41.
 *
 * Found by dogfooding, not by review. Pointed at a real model with no tool
 * channel, the harness asked it to read a file. The model wrote tool-call
 * syntax as prose, invented the file's contents, and drew a conclusion from
 * them — and the harness printed that conclusion as the answer. No tool ran.
 * The file said one thing; the user was told another.
 *
 * Two defences, because either alone is thin. A provider that cannot call
 * tools is told so and offered none, which removes most of the temptation.
 * And narrated tool use fails the run, which catches what remains.
 */

/** A provider that does what the real one did: narrate a call it cannot make. */
class NarratingProvider implements Provider {
  readonly id = "narrator";
  lastRequest?: ModelRequest;

  constructor(
    private readonly advertisesTools: boolean,
    private readonly narration?: string,
  ) {}

  capabilities(): readonly string[] {
    return this.advertisesTools ? [CAP_TEXT_GENERATE, CAP_TOOL_CALL] : [CAP_TEXT_GENERATE];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: "fake" };
  }

  async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.lastRequest = request;

    // A specific narration, when a case is about one particular wrapping.
    if (this.narration !== undefined) {
      yield { type: "delta", text: this.narration };
      yield { type: "done", reason: "stop" };
      return;
    }

    yield { type: "delta", text: "Reading the file now.\n\n" };
    yield { type: "delta", text: '<function_calls>\n<invoke name="Read">\n' };
    yield { type: "delta", text: "</function_calls>\n<function_response>\n<output>\n" };
    yield { type: "delta", text: "Release Date: 2025-03-14\n</output>\n</function_response>\n\n" };
    yield { type: "delta", text: "The release date is 2025-03-14." };
    yield { type: "done", reason: "stop" };
  }
}

async function ask(provider: Provider, dir: string) {
  const daemon = await startDaemon({ workspace: dir, stateDir: dir, provider });
  try {
    const headers = {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    };
    const { id } = (await (
      await fetch(`${daemon.url}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workspace: dir }),
      })
    ).json()) as { id: string };

    const outcome = (await (
      await fetch(`${daemon.url}/sessions/${id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "read facts.txt and tell me the release date" }),
      })
    ).json()) as { status: string; detail?: string };

    const { events } = (await (
      await fetch(`${daemon.url}/sessions/${id}/events`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      })
    ).json()) as { events: Array<Record<string, unknown>> };

    return { outcome, events };
  } finally {
    await daemon.close();
  }
}

describe("SEC-022: narrated tool use fails the run", () => {
  it("does not report a fabricated result as a completed answer", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "facts.txt"), "The release date is 2026-04-01.\n");

      const { outcome, events } = await ask(new NarratingProvider(true), dir);

      expect(outcome.status).toBe("error");
      expect(outcome.detail).toContain("invented");
      // The give-away in the original incident: no tool ever ran.
      expect(events.some((e) => e.type === "tool.finished")).toBe(false);
    });
  });

  it("names the kind of syntax it saw, so the cause is not a mystery", async () => {
    await withTempDir(async (dir) => {
      const { outcome } = await ask(new NarratingProvider(true), dir);
      expect(outcome.detail).toContain("tool-shaped");
    });
  });

  it.each([
    ["Anthropic-style", '<function_calls>\n<invoke name="Read">\n</function_calls>'],
    ["a bare tool tag", '<tool>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool>'],
    ["a tool_call tag", '<tool_call>{"name":"read"}</tool_call>'],
    ["a fenced block", '```tool_code\nread("a.txt")\n```'],
    ["a delimiter form", '[TOOL_CALL] read a.txt [/TOOL_CALL]'],
    ["bare call-shaped JSON", 'I will do: {"name": "read", "arguments": {"path": "a.txt"}}'],
  ])("catches %s", async (_label, narration) => {
    // The first version of this guard was a list of literal tags and missed
    // the next model it met — a local Qwen using <tool>. Each row here is a
    // wrapping some model actually reaches for.
    await withTempDir(async (dir) => {
      const provider = new NarratingProvider(true, narration);
      const { outcome } = await ask(provider, dir);
      expect(outcome.status).toBe("error");
    });
  });

  it("does not fire on ordinary prose that merely mentions tools", async () => {
    // A guard that trips on "you could use the read tool here" would make the
    // harness unusable for talking about itself.
    await withTempDir(async (dir) => {
      const provider = new NarratingProvider(
        true,
        "You could use the read tool for that, or call a function that returns the name and arguments.",
      );
      const { outcome } = await ask(provider, dir);
      expect(outcome.status).toBe("completed");
    });
  });

  it("keeps the transcript rather than scrubbing the narration", async () => {
    // Stripping the markup would leave "the release date is 2025-03-14"
    // standing as an ordinary answer, which is the harmful part. The record
    // shows what the model actually produced.
    await withTempDir(async (dir) => {
      const { events } = await ask(new NarratingProvider(true), dir);
      const answer = events
        .filter((e) => e.type === "answer.delta")
        .map((e) => e["text"])
        .join("");
      expect(answer).toContain("<function_calls>");
    });
  });
});

describe("SEC-022: a provider without tools is told so", () => {
  it("offers no tools to a provider that cannot call them", async () => {
    await withTempDir(async (dir) => {
      const provider = new NarratingProvider(false);
      await ask(provider, dir);

      expect(provider.lastRequest?.tools).toBeUndefined();
    });
  });

  it("tells it plainly that it has none, so it declines instead of inventing", async () => {
    await withTempDir(async (dir) => {
      const provider = new NarratingProvider(false);
      await ask(provider, dir);

      const system = provider.lastRequest?.messages.find((m) => m.role === "system");
      expect(system?.content).toContain("no tools");
      expect(system?.content).toContain("never state the result of a call you did not make");
    });
  });

  it("still offers tools to a provider that advertises the capability", async () => {
    await withTempDir(async (dir) => {
      const provider = new NarratingProvider(true);
      await ask(provider, dir);

      expect(provider.lastRequest?.tools?.length).toBeGreaterThan(0);
      expect(provider.lastRequest?.messages.some((m) => m.role === "system")).toBe(false);
    });
  });
});
