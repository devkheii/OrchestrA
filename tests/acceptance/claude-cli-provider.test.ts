import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { ModelEvent } from "@dem/protocol";
import { ClaudeCliProvider } from "@dem/adapters";

/**
 * The Claude Code CLI as a text provider.
 *
 * Run against a stand-in rather than the real binary. A real call spends the
 * user's Claude subscription quota — the same five-hour window they use for
 * their own work — so a suite that called it would compete with the person
 * running it. The stand-in emits the same stream-json frames the real CLI does.
 */

const FAKE_CLI = fileURLToPath(new URL("../helpers/fake-claude-cli.mjs", import.meta.url));

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function textOf(events: ModelEvent[]): string {
  return events.filter((e) => e.type === "delta").map((e) => e.text).join("");
}

function ask(content: string) {
  return { messages: [{ role: "user" as const, content }] };
}

/**
 * Runs the stand-in under node. Windows cannot execute a .mjs file directly,
 * and the adapter has no business knowing that, so the prefix lives in config.
 */
function fakeProvider() {
  return new ClaudeCliProvider({
    command: process.execPath,
    commandArgs: [FAKE_CLI],
    env: { ...process.env },
  });
}

describe("Claude CLI provider: egress classification", () => {
  it("is never local, however local the binary is", () => {
    // The tempting bug: the process runs on this machine, so call it local.
    // Every prompt it receives goes to Anthropic. Egress policy follows the
    // data, not the executable — otherwise a whole workspace leaves the
    // machine while the interface says LOCAL.
    expect(new ClaudeCliProvider().isLocal()).toBe(false);
    expect(new ClaudeCliProvider({ model: "opus" }).isLocal()).toBe(false);
  });

  it("does not advertise tool.call, because tools belong to the harness", () => {
    // If the CLI ran its own Bash and Edit, file writes would happen under its
    // permission model rather than ours — which invariant 7 forbids.
    expect(new ClaudeCliProvider().capabilities()).not.toContain("tool.call");
  });

  it("keeps the model name out of nothing sensitive and identifies itself", () => {
    expect(new ClaudeCliProvider({ model: "opus" }).id).toBe("claude-cli:opus");
  });
});

describe("Claude CLI provider: streaming", () => {
  it("delivers the prompt and streams text deltas", async () => {
    const events = await collect(fakeProvider().run(ask("hello there")));
    expect(textOf(events)).toBe("echo: hello there");
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  it("keeps thinking out of the answer, surfacing it as rationale", async () => {
    // The real CLI emits no thinking frames today — probing found none, and no
    // flag produces them. The handling exists because the frame shape is the
    // provider's to decide, and this asserts it lands on the rationale channel
    // rather than in the answer if it ever does (SPEC §15.1).
    const events = await collect(fakeProvider().run(ask("SCENARIO_THINKING")));

    expect(textOf(events)).toBe("visible answer");
    expect(textOf(events)).not.toContain("SECRET_REASONING");

    const rationale = events.filter((e) => e.type === "rationale").map((e) => e.text).join("");
    expect(rationale).toBe("SECRET_REASONING");
  });

  it("reports a truncated answer as length, not a clean stop", async () => {
    const events = await collect(fakeProvider().run(ask("SCENARIO_TRUNCATED")));
    expect(events.at(-1)).toEqual({ type: "done", reason: "length" });
  });

  it("still yields an answer when the run reports only a final result", async () => {
    // Otherwise a caller receives a silent empty response and cannot tell it
    // from a model that genuinely said nothing.
    const events = await collect(fakeProvider().run(ask("SCENARIO_RESULT_ONLY")));
    expect(textOf(events)).toBe("final only");
  });

  it("skips unparseable lines rather than failing the stream", async () => {
    const events = await collect(fakeProvider().run(ask("SCENARIO_GARBAGE")));
    expect(textOf(events)).toBe("still works");
  });

  it("refuses to run when the CLI still advertises a tool we did not disallow", async () => {
    // The denylist cannot anticipate a tool added in a future CLI release, so
    // an unexpected tool stops the run instead of quietly reaching the model
    // with capabilities that never pass our permission broker.
    const events = await collect(fakeProvider().run(ask("SCENARIO_LEAKED_TOOL")));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("BrandNewTool");
    expect((events[0] as { message: string }).message).toContain("permission broker");
  });

  it("surfaces an error frame as an error event", async () => {
    const events = await collect(fakeProvider().run(ask("SCENARIO_ERROR")));
    expect(events.at(-1)).toEqual({ type: "error", message: "upstream failed" });
  });

  it("stops and kills the child when the caller aborts", async () => {
    const abort = new AbortController();
    const seen: string[] = [];

    for await (const event of fakeProvider().run(ask("SCENARIO_SLOW"), { signal: abort.signal })) {
      if (event.type === "delta") {
        seen.push(event.text);
        if (seen.length === 2) abort.abort();
      }
    }

    // The stand-in would emit 50 chunks if nothing stopped it.
    expect(seen.length).toBeLessThan(10);
  });
});

describe("Claude CLI provider: health", () => {
  it("reports ok when the binary answers --version", async () => {
    const health = await fakeProvider().health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("Fake Claude Code");
  });

  it("reports not-ok rather than throwing when the binary is missing", async () => {
    const missing = new ClaudeCliProvider({ command: "definitely-not-a-real-binary-xyz" });
    const health = await missing.health();
    expect(health.ok).toBe(false);
  });
});
