import { describe, expect, it } from "vitest";
import type { ModelEvent } from "@dem/protocol";
import { OpenAICompatibleProvider } from "@dem/adapters";
import { startDaemon } from "@dem/daemon";
import { delta, finish, startFakeOpenAI } from "../helpers/openai-server.js";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-019 — invariant 35.
 *
 * A model's reasoning is either a public rationale or it is not kept. The line
 * is drawn by structure, not by wording: a summary the model wrote to be read
 * may be shown and stored, provided it stays a separate labelled thing. Merged
 * into the answer it becomes indistinguishable from one, and from that moment
 * it has to be treated as the hidden chain-of-thought invariant 17 forbids.
 *
 * Both halves are tested because either alone is satisfiable by the wrong
 * implementation: dropping everything passes "not in the answer", and
 * concatenating everything passes "rationale is available".
 */

const reasoningDelta = (text: string, key = "reasoning_content"): unknown => ({
  choices: [{ index: 0, delta: { [key]: text }, finish_reason: null }],
});

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const ASK = { messages: [{ role: "user" as const, content: "why?" }] };

describe("SEC-019: rationale is surfaced, separately from the answer", () => {
  it("emits reasoning as its own event, not as answer text", async () => {
    const server = await startFakeOpenAI({
      frames: [reasoningDelta("I weighed two options"), delta("Option B."), finish("stop")],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "r" });
      const events = await collect(provider.run(ASK));

      const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      const rationale = events.filter((e) => e.type === "rationale").map((e) => e.text).join("");

      expect(answer).toBe("Option B.");
      expect(answer).not.toContain("weighed");
      expect(rationale).toBe("I weighed two options");
    } finally {
      await server.close();
    }
  });

  it("recognises the field under each name providers use for it", async () => {
    for (const key of ["reasoning", "reasoning_content", "thinking"]) {
      const server = await startFakeOpenAI({
        frames: [reasoningDelta("because", key), delta("answer"), finish("stop")],
      });
      try {
        const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "r" });
        const events = await collect(provider.run(ASK));
        const rationale = events.filter((e) => e.type === "rationale").map((e) => e.text).join("");
        expect(rationale, `field name ${key}`).toBe("because");
      } finally {
        await server.close();
      }
    }
  });

  it("orders rationale before the answer it led to", async () => {
    const server = await startFakeOpenAI({
      frames: [
        { choices: [{ index: 0, delta: { reasoning_content: "first", content: "second" } }] },
        finish("stop"),
      ],
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "r" });
      const events = await collect(provider.run(ASK));
      const kinds = events.map((e) => e.type);
      expect(kinds.indexOf("rationale")).toBeLessThan(kinds.indexOf("delta"));
    } finally {
      await server.close();
    }
  });

  it("says nothing when the provider supplies no rationale", async () => {
    // An empty rationale is the honest answer for a provider that offers none,
    // and is not a reason to synthesise one.
    const server = await startFakeOpenAI({ frames: [delta("bare answer"), finish("stop")] });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "r" });
      const events = await collect(provider.run(ASK));
      expect(events.some((e) => e.type === "rationale")).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe("SEC-019: display and audit do not diverge", () => {
  it("records rationale in the event log, under its own event type", async () => {
    // A harness claiming auditability cannot show the user something its record
    // does not contain. Persisting it is what makes displaying it defensible.
    const server = await startFakeOpenAI({
      frames: [reasoningDelta("the tests were failing"), delta("Fixed."), finish("stop")],
    });
    try {
      await withTempDir(async (dir) => {
        const daemon = await startDaemon({
          workspace: dir,
          stateDir: dir,
          provider: new OpenAICompatibleProvider({ baseUrl: server.url, model: "r" }),
        });
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

          await fetch(`${daemon.url}/sessions/${id}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ content: "why?" }),
          });

          const { events } = (await (
            await fetch(`${daemon.url}/sessions/${id}/events`, {
              headers: { authorization: `Bearer ${daemon.token}` },
            })
          ).json()) as { events: Array<{ type: string; text?: string }> };

          const rationale = events.filter((e) => e.type === "answer.rationale");
          const answer = events.filter((e) => e.type === "answer.delta");

          expect(rationale.map((e) => e.text).join("")).toBe("the tests were failing");
          expect(answer.map((e) => e.text).join("")).toBe("Fixed.");
          // The separation survives persistence, which is the point.
          expect(answer.map((e) => e.text).join("")).not.toContain("tests were failing");
        } finally {
          await daemon.close();
        }
      });
    } finally {
      await server.close();
    }
  });
});
