import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeProvider, type FakeTurn } from "@dem/adapters";
import { startDaemon } from "@dem/daemon";
import { withTempDir } from "../helpers/temp.js";

/**
 * Acceptance: the agent loop. Model, tool, model — with the broker between
 * every call and its effect (invariant 36).
 *
 * The loop keeps no state of its own; it rebuilds from the event log each
 * time. These tests lean on that: approval arrives as a separate request, and
 * the run continues from the record rather than from something held in memory.
 */

interface Harness {
  url: string;
  token: string;
  headers: Record<string, string>;
  dir: string;
}

async function withHarness(
  script: readonly FakeTurn[],
  fn: (h: Harness, setup: (dir: string) => Promise<void>) => Promise<void>,
  setup: (dir: string) => Promise<void> = async () => {},
): Promise<void> {
  await withTempDir(async (dir) => {
    await setup(dir);
    const daemon = await startDaemon({
      workspace: dir,
      stateDir: dir,
      provider: new FakeProvider(script),
    });
    try {
      await fn(
        {
          url: daemon.url,
          token: daemon.token,
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          dir,
        },
        setup,
      );
    } finally {
      await daemon.close();
    }
  });
}

async function newSession(h: Harness): Promise<string> {
  const res = await fetch(`${h.url}/sessions`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify({ workspace: h.dir }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function say(h: Harness, id: string, content: string) {
  const res = await fetch(`${h.url}/sessions/${id}/messages`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify({ content }),
  });
  return (await res.json()) as { status: string; pending?: { call: { id: string } } };
}

async function eventsOf(h: Harness, id: string) {
  const res = await fetch(`${h.url}/sessions/${id}/events`, {
    headers: { authorization: `Bearer ${h.token}` },
  });
  return ((await res.json()) as { events: Array<Record<string, unknown>> }).events;
}

const readTool = (path: string): FakeTurn => ({
  toolCalls: [{ id: "call_read", name: "read", arguments: { path } }],
});

describe("Agent loop: a tool call completes a task", () => {
  it("reads a file and answers from what it read", async () => {
    await withHarness(
      [readTool("notes.txt"), { text: "The file says: hello from disk" }],
      async (h) => {
        const id = await newSession(h);
        const outcome = await say(h, id, "what is in notes.txt?");
        expect(outcome.status).toBe("completed");

        const events = await eventsOf(h, id);
        const types = events.map((e) => e.type);

        expect(types).toContain("tool.requested");
        expect(types).toContain("permission.resolved");
        expect(types).toContain("tool.finished");

        const finished = events.find((e) => e.type === "tool.finished");
        expect(finished?.["ok"]).toBe(true);
        expect(String(finished?.["result"])).toContain("hello from disk");

        const answer = events
          .filter((e) => e.type === "answer.delta")
          .map((e) => e["text"])
          .join("");
        expect(answer).toContain("hello from disk");
      },
      async (dir) => {
        await writeFile(join(dir, "notes.txt"), "hello from disk\n");
      },
    );
  });

  it("records a permission decision for a call that was auto-allowed", async () => {
    // Auto is still a decision. A tool that ran without one appearing in the
    // log would mean the broker was skipped, which is the failure SEC-020
    // guards and the log is where anyone would notice.
    await withHarness(
      [readTool("notes.txt"), { text: "done" }],
      async (h) => {
        const id = await newSession(h);
        await say(h, id, "read it");
        const events = await eventsOf(h, id);
        const resolved = events.find((e) => e.type === "permission.resolved");
        expect((resolved?.["decision"] as { outcome: string }).outcome).toBe("auto");
      },
      async (dir) => {
        await writeFile(join(dir, "notes.txt"), "x\n");
      },
    );
  });
});

describe("Agent loop: approval round-trip", () => {
  const shellTurn: FakeTurn = {
    toolCalls: [{ id: "call_shell", name: "shell", arguments: { command: "echo ran" } }],
  };

  it("stops and asks before running a shell command in ASK mode", async () => {
    await withHarness([shellTurn, { text: "finished" }], async (h) => {
      const id = await newSession(h);
      const outcome = await say(h, id, "run something");

      expect(outcome.status).toBe("awaiting_approval");
      expect(outcome.pending?.call.id).toBe("call_shell");

      const events = await eventsOf(h, id);
      expect(events.map((e) => e.type)).toContain("permission.requested");
      // Nothing ran: the pause is before the effect, not after it.
      expect(events.map((e) => e.type)).not.toContain("tool.started");
    });
  });

  it("continues the task once the user approves", async () => {
    await withHarness([shellTurn, { text: "finished" }], async (h) => {
      const id = await newSession(h);
      const paused = await say(h, id, "run something");
      expect(paused.status).toBe("awaiting_approval");

      const res = await fetch(`${h.url}/sessions/${id}/approve`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ callId: "call_shell" }),
      });
      const resumed = (await res.json()) as { status: string };
      expect(resumed.status).toBe("completed");

      const events = await eventsOf(h, id);
      const types = events.map((e) => e.type);
      expect(types).toContain("permission.granted");
      expect(types).toContain("tool.finished");

      const finished = events.find((e) => e.type === "tool.finished");
      expect(String(finished?.["result"])).toContain("ran");
    });
  });

  it("records the grant separately from the decision that asked for it", async () => {
    // Mutating the original record would lose the difference between "the
    // broker allowed this" and "a person allowed this", which is the whole
    // content of an approval.
    await withHarness([shellTurn, { text: "ok" }], async (h) => {
      const id = await newSession(h);
      await say(h, id, "run something");
      await fetch(`${h.url}/sessions/${id}/approve`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ callId: "call_shell" }),
      });

      const events = await eventsOf(h, id);
      const asked = events.find((e) => e.type === "permission.requested");
      const granted = events.find((e) => e.type === "permission.granted");

      expect(asked).toBeDefined();
      expect(granted?.["by"]).toBe("user");
      expect(Number(granted?.["seq"])).toBeGreaterThan(Number(asked?.["seq"]));
    });
  });

  it("rejects an approval that names no call", async () => {
    await withHarness([shellTurn], async (h) => {
      const id = await newSession(h);
      await say(h, id, "run something");
      const res = await fetch(`${h.url}/sessions/${id}/approve`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("Agent loop: bounded", () => {
  it("stops after maxRounds and reports it rather than finishing quietly", async () => {
    // A model that calls a tool forever would otherwise look like a session
    // that is still working, and a transcript that ends mid-task reads as a
    // completed one.
    const looping: FakeTurn[] = Array.from({ length: 20 }, () => readTool("notes.txt"));

    await withTempDir(async (dir) => {
      await writeFile(join(dir, "notes.txt"), "x\n");
      const daemon = await startDaemon({
        workspace: dir,
        stateDir: dir,
        provider: new FakeProvider(looping),
        maxRounds: 3,
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

        const res = await fetch(`${daemon.url}/sessions/${id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "loop please" }),
        });
        const outcome = (await res.json()) as { status: string; detail?: string };

        expect(outcome.status).toBe("budget");
        expect(outcome.detail).toContain("3");
      } finally {
        await daemon.close();
      }
    });
  });

  it("surfaces a failing tool to the model instead of ending the session", async () => {
    await withHarness([readTool("does-not-exist.txt"), { text: "I could not read it" }], async (h) => {
      const id = await newSession(h);
      const outcome = await say(h, id, "read a missing file");

      expect(outcome.status).toBe("completed");
      const events = await eventsOf(h, id);
      const finished = events.find((e) => e.type === "tool.finished");
      expect(finished?.["ok"]).toBe(false);
    });
  });
});

describe("Agent loop: the workspace actually changes", () => {
  it("writes a file through patch once approved", async () => {
    const patchTurn: FakeTurn = {
      toolCalls: [
        {
          id: "call_patch",
          name: "patch",
          arguments: { path: "created.txt", content: "written by the agent\n" },
        },
      ],
    };

    await withHarness([patchTurn, { text: "created it" }], async (h) => {
      const id = await newSession(h);
      const paused = await say(h, id, "create a file");
      expect(paused.status).toBe("awaiting_approval");

      await fetch(`${h.url}/sessions/${id}/approve`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ callId: "call_patch" }),
      });

      expect(await readFile(join(h.dir, "created.txt"), "utf8")).toBe("written by the agent\n");
    });
  });
});
