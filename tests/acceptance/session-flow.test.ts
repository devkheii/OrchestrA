import { describe, expect, it } from "vitest";
import { startDaemon } from "@dem/daemon";
import { FakeProvider } from "@dem/adapters";
import { withTempDir } from "../helpers/temp.js";

/**
 * Acceptance: a session completes over the API alone, with no UI and no real
 * model (plan, Phase 0 acceptance and Phase 1 step 4).
 *
 * FakeProvider exists so the security suites never depend on a model being
 * loaded. A security test that needs a 20GB GGUF present is a security test
 * that stops being run.
 */

async function withDaemon<T>(
  fn: (d: { url: string; token: string; headers: Record<string, string> }) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const daemon = await startDaemon({
      workspace: dir,
      stateDir: dir,
      provider: new FakeProvider(["Hello", ", ", "world."]),
    });
    try {
      return await fn({
        url: daemon.url,
        token: daemon.token,
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      });
    } finally {
      await daemon.close();
    }
  });
}

describe("FakeProvider streams deterministically", () => {
  it("emits the same chunks every time for the same input", async () => {
    const collect = async () => {
      const out: string[] = [];
      for await (const ev of new FakeProvider(["a", "b"]).run({ messages: [{ role: "user", content: "x" }] })) {
        if (ev.type === "delta") out.push(ev.text);
      }
      return out;
    };
    expect(await collect()).toEqual(["a", "b"]);
    expect(await collect()).toEqual(await collect());
  });

  it("ends with a done event so a consumer knows the stream closed cleanly", async () => {
    const types: string[] = [];
    for await (const ev of new FakeProvider(["a"]).run({ messages: [] })) types.push(ev.type);
    expect(types.at(-1)).toBe("done");
  });

  it("stops when the caller aborts", async () => {
    const abort = new AbortController();
    const seen: string[] = [];
    const provider = new FakeProvider(["a", "b", "c", "d"]);
    for await (const ev of provider.run({ messages: [] }, { signal: abort.signal })) {
      if (ev.type === "delta") {
        seen.push(ev.text);
        if (seen.length === 2) abort.abort();
      }
    }
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("Acceptance: a session runs end to end over the API", () => {
  it("creates a session, accepts a message, and streams an answer", async () => {
    await withDaemon(async (d) => {
      const created = await fetch(`${d.url}/sessions`, {
        method: "POST",
        headers: d.headers,
        body: JSON.stringify({ workspace: "." }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      expect(id).toMatch(/^ses_/);

      const sent = await fetch(`${d.url}/sessions/${id}/messages`, {
        method: "POST",
        headers: d.headers,
        body: JSON.stringify({ content: "hello" }),
      });
      expect(sent.status).toBe(202);

      const events = await fetch(`${d.url}/sessions/${id}/events`, {
        headers: { authorization: `Bearer ${d.token}` },
      });
      expect(events.status).toBe(200);
      const log = (await events.json()) as { events: Array<{ type: string; text?: string }> };

      const types = log.events.map((e) => e.type);
      expect(types).toContain("session.started");
      expect(types).toContain("message.received");
      expect(types).toContain("answer.delta");
      expect(types).toContain("session.completed");

      const answer = log.events
        .filter((e) => e.type === "answer.delta")
        .map((e) => e.text)
        .join("");
      expect(answer).toBe("Hello, world.");
    });
  });

  it("keeps the ordering the daemon assigned, not the order a client asks in", async () => {
    await withDaemon(async (d) => {
      const { id } = (await (
        await fetch(`${d.url}/sessions`, {
          method: "POST",
          headers: d.headers,
          body: JSON.stringify({ workspace: "." }),
        })
      ).json()) as { id: string };

      await fetch(`${d.url}/sessions/${id}/messages`, {
        method: "POST",
        headers: d.headers,
        body: JSON.stringify({ content: "hello" }),
      });

      const log = (await (
        await fetch(`${d.url}/sessions/${id}/events`, {
          headers: { authorization: `Bearer ${d.token}` },
        })
      ).json()) as { events: Array<{ seq: number }> };

      const seqs = log.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    });
  });

  it("reports 404 for a session that does not exist rather than inventing one", async () => {
    await withDaemon(async (d) => {
      const res = await fetch(`${d.url}/sessions/ses_nope/events`, {
        headers: { authorization: `Bearer ${d.token}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
