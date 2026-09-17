import { describe, expect, it } from "vitest";
import { FakeProvider, type FakeTurn } from "@dem/adapters";
import { startDaemon } from "@dem/daemon";
import { createSession, runTurn, sessionApprover, type Approver, type Io, type PendingCall } from "@dem/cli";
import { withTempDir } from "../helpers/temp.js";

/**
 * The turn machinery the one-shot command and the interactive loop share.
 *
 * Approval is injected rather than read from a terminal, which is what makes
 * it testable at all — and an approval path that is never exercised is the one
 * place in this harness that should not be.
 */

function capture(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };
  return io;
}

const approveAll: Approver = async () => true;
const declineAll: Approver = async () => false;

async function withHarness(
  script: readonly FakeTurn[],
  fn: (ctx: {
    daemon: Awaited<ReturnType<typeof startDaemon>>;
    sessionId: string;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const daemon = await startDaemon({
      workspace: dir,
      stateDir: dir,
      provider: new FakeProvider(script),
    });
    try {
      const sessionId = await createSession(daemon, dir);
      await fn({ daemon, sessionId, dir });
    } finally {
      await daemon.close();
    }
  });
}

describe("A turn renders the answer and the reasoning separately", () => {
  it("puts the answer on stdout and nothing else", async () => {
    // A pipe should receive the answer alone. Everything the harness says
    // about its own work goes to stderr.
    await withHarness([{ text: "the answer" }], async ({ daemon, sessionId }) => {
      const io = capture();
      await runTurn(daemon, sessionId, "ask", io, approveAll);

      expect(io.stdout.trim()).toBe("the answer");
    });
  });

  it("shows a tool that ran, on stderr", async () => {
    await withHarness(
      [
        { toolCalls: [{ id: "c1", name: "read", arguments: { path: "x" } }] },
        { text: "done" },
      ],
      async ({ daemon, sessionId }) => {
        const io = capture();
        await runTurn(daemon, sessionId, "read it", io, approveAll);

        expect(io.stderr).toContain("read");
        expect(io.stdout).not.toContain("●");
      },
    );
  });
});

describe("Approval is asked once per call, and a decline stops the turn", () => {
  const shellTurn: FakeTurn = {
    toolCalls: [{ id: "c_shell", name: "shell", arguments: { command: "echo hi" } }],
  };

  it("asks before running, with the exact command in the prompt", async () => {
    // A prompt reading "run a shell command?" trains the user to say yes
    // without looking, which turns every later approval into a formality.
    await withHarness([shellTurn, { text: "done" }], async ({ daemon, sessionId }) => {
      const io = capture();
      const seen: PendingCall[] = [];

      await runTurn(daemon, sessionId, "run it", io, async (p) => {
        seen.push(p);
        return true;
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.call.arguments["command"]).toBe("echo hi");
      expect(seen[0]?.rule).toBeTruthy();
    });
  });

  it("stops without running when the user declines", async () => {
    await withHarness([shellTurn, { text: "done" }], async ({ daemon, sessionId }) => {
      const io = capture();
      const result = await runTurn(daemon, sessionId, "run it", io, declineAll);

      expect(result.status).toBe("declined");
      expect(io.stderr).toContain("declined");
      expect(io.stdout).not.toContain("done");
    });
  });

  it("continues the task after approval", async () => {
    await withHarness([shellTurn, { text: "finished" }], async ({ daemon, sessionId }) => {
      const io = capture();
      const result = await runTurn(daemon, sessionId, "run it", io, approveAll);

      expect(result.status).toBe("completed");
      expect(io.stdout).toContain("finished");
    });
  });
});

describe("A session carries across turns", () => {
  it("does not reprint earlier turns", async () => {
    // The interactive loop renders from a watermark. Without it every turn
    // would replay the whole conversation, which is unreadable by the third
    // exchange.
    await withHarness(
      [{ text: "first answer" }, { text: "second answer" }],
      async ({ daemon, sessionId }) => {
        const first = capture();
        const a = await runTurn(daemon, sessionId, "one", first, approveAll);
        expect(first.stdout).toContain("first answer");

        const second = capture();
        await runTurn(daemon, sessionId, "two", second, approveAll, a.seq);

        expect(second.stdout).toContain("second answer");
        expect(second.stdout).not.toContain("first answer");
      },
    );
  });

  it("gives the model what was said before", async () => {
    // The whole point of one session: the second turn can build on the first.
    await withHarness([{ text: "ok" }, { text: "ok" }], async ({ daemon, sessionId, dir }) => {
      const io = capture();
      const a = await runTurn(daemon, sessionId, "my name is Kheii", io, approveAll);
      await runTurn(daemon, sessionId, "what is my name?", io, approveAll, a.seq);

      const res = await fetch(`${daemon.url}/sessions/${sessionId}/events`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      const { events } = (await res.json()) as { events: Array<{ type: string; content?: string }> };
      const asked = events.filter((e) => e.type === "message.received").map((e) => e.content);

      expect(asked).toEqual(["my name is Kheii", "what is my name?"]);
      expect(dir).toBeTruthy();
    });
  });
});

describe("Session-scoped approval (SPEC 19: scopes, not just once)", () => {
  const io = { out: () => {}, err: () => {} };
  const pending = (name: string, command: string) => ({
    call: { id: "call_1", name, arguments: { command } },
    rule: "requires approval in ASK mode",
  });

  it("stops asking about the exact thing the user said always to", async () => {
    // A fix-and-rerun loop asks about `npm test` on every iteration. An
    // approval asked too often stops being read.
    const asked: string[] = [];
    const approve = sessionApprover(async (q) => {
      asked.push(q);
      return "a";
    }, io);

    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("does not carry that approval to a different command", async () => {
    // The whole point of scoping by subject: yes to `npm test` is not yes to
    // `rm -rf build`.
    let answers = ["a", "n"];
    const approve = sessionApprover(async () => answers.shift()!, io);

    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(await approve(pending("shell", "rm -rf build"))).toBe(false);
  });

  it("does not carry that approval to a different tool", async () => {
    let answers = ["a", "n"];
    const approve = sessionApprover(async () => answers.shift()!, io);

    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(await approve(pending("terminal", "npm test"))).toBe(false);
  });

  it("asks again every time for a plain yes", async () => {
    const asked: string[] = [];
    const approve = sessionApprover(async (q) => {
      asked.push(q);
      return "y";
    }, io);

    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(await approve(pending("shell", "npm test"))).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("treats anything it does not recognise as no", async () => {
    // A mistyped key must not approve. The default has to fail closed.
    for (const answer of ["", " ", "sure", "yep", "always?", "Y E S"]) {
      const approve = sessionApprover(async () => answer, io);
      expect(await approve(pending("shell", "rm -rf /"))).toBe(false);
    }
  });

  it("scopes the approval to this approver, not to the process", async () => {
    // `/new` starts a fresh session; approvals granted in the old one must not
    // survive it, because the user granted them for a conversation.
    const first = sessionApprover(async () => "a", io);
    expect(await first(pending("shell", "npm test"))).toBe(true);

    const asked: string[] = [];
    const second = sessionApprover(async (q) => {
      asked.push(q);
      return "n";
    }, io);
    expect(await second(pending("shell", "npm test"))).toBe(false);
    expect(asked).toHaveLength(1);
  });
});
