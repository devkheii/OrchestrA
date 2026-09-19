import { describe, expect, it } from "vitest";
import { cancelRun, createTerminalManager } from "@dem/engine";

/**
 * SEC-005 (continued) and RUN-001 — the long-lived terminal.
 *
 * A PTY is the loosest surface the harness exposes. It survives between tool
 * calls, it holds a live shell, and its output is fed back to a model. Every
 * property the one-shot `shell.exec` path establishes has to be re-established
 * here, because none of them carry over: a sanitiser applied in one spawn site
 * protects nothing at the other.
 */

const PRINT_ENV = "console.log(JSON.stringify(process.env))";

function waitFor(
  terminal: { onData(cb: (c: string) => void): () => void; snapshot(): string },
  predicate: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (predicate(terminal.snapshot())) return resolve(terminal.snapshot());
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out; saw: ${JSON.stringify(terminal.snapshot().slice(0, 300))}`));
    }, timeoutMs);
    const off = terminal.onData(() => {
      if (predicate(terminal.snapshot())) {
        clearTimeout(timer);
        off();
        resolve(terminal.snapshot());
      }
    });
  });
}

describe("SEC-005: a PTY child cannot see provider secrets either", () => {
  it("does not inherit a secret present in the daemon", async () => {
    const key = "ANTHROPIC_API_KEY";
    const value = "sk-ant-must-not-leak";
    const previous = process.env[key];
    process.env[key] = value;

    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", PRINT_ENV],
        cwd: process.cwd(),
      });

      const output = await waitFor(terminal, (t) => t.includes("}"));
      expect(output).not.toContain(value);
      expect(output).not.toContain(key);
    } finally {
      manager.stopAll();
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe("Terminal: a live shell that stays usable", () => {
  it("runs a command and returns its output", async () => {
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", "console.log('MARKER_ALPHA')"],
        cwd: process.cwd(),
      });
      const output = await waitFor(terminal, (t) => t.includes("MARKER_ALPHA"));
      expect(output).toContain("MARKER_ALPHA");
    } finally {
      manager.stopAll();
    }
  });

  it("accepts input written after start, which is the point of a PTY", async () => {
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data', (d) => console.log('GOT:' + d.toString().trim()))",
        ],
        cwd: process.cwd(),
      });
      terminal.write("ping\r");
      const output = await waitFor(terminal, (t) => t.includes("GOT:ping"));
      expect(output).toContain("GOT:ping");
    } finally {
      manager.stopAll();
    }
  });

  it("resolves `exited` with the process exit code", async () => {
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        cwd: process.cwd(),
      });
      expect(await terminal.exited).toBe(3);
    } finally {
      manager.stopAll();
    }
  });
});

describe("Terminal: bounded and redacted, because a model reads this", () => {
  it("caps scrollback rather than growing without limit", async () => {
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", "for (let i = 0; i < 2000; i++) console.log('line ' + i)"],
        cwd: process.cwd(),
        maxScrollbackBytes: 2000,
      });
      await terminal.exited;
      expect(terminal.snapshot().length).toBeLessThanOrEqual(2000);
    } finally {
      manager.stopAll();
    }
    // Spawning a PTY and draining 2,000 lines through it is not fast, and the
    // assertion is about the scrollback cap rather than the clock. Under vitest's
    // 5s default this passed alone and failed in a full parallel run, which is
    // the shape of a test that would fail in CI for no reason anyone could act on.
  }, 30_000);

  it("keeps the most recent output when it truncates", async () => {
    // A terminal that drops the newest lines is worse than useless: the model
    // is shown the start of a build and never the error that ended it.
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", "for (let i = 0; i < 500; i++) console.log('line ' + i); console.log('LAST_LINE')"],
        cwd: process.cwd(),
        maxScrollbackBytes: 500,
      });
      await terminal.exited;
      expect(terminal.snapshot()).toContain("LAST_LINE");
    } finally {
      manager.stopAll();
    }
  });

  it("redacts known secret values from what the model is shown", async () => {
    const manager = createTerminalManager();
    try {
      const terminal = manager.start({
        command: process.execPath,
        args: ["-e", "console.log('token=sk-live-terminal-leak')"],
        cwd: process.cwd(),
        redactValues: ["sk-live-terminal-leak"],
      });
      await waitFor(terminal, (t) => t.includes("token="));
      expect(terminal.snapshot()).not.toContain("sk-live-terminal-leak");
    } finally {
      manager.stopAll();
    }
  });
});

describe("RUN-001: cancellation reaches the terminal", () => {
  it("closes a live PTY and leaves no process behind", async () => {
    const manager = createTerminalManager();
    const terminal = manager.start({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
    });

    const abort = new AbortController();
    await cancelRun({ pids: [], ptyIds: [terminal.id], abort, terminals: manager }, 2000);

    expect(abort.signal.aborted).toBe(true);
    expect(manager.get(terminal.id)).toBeUndefined();
    expect(() => process.kill(terminal.pid, 0)).toThrow();
  });

  it("does not fail when a terminal already exited on its own", async () => {
    const manager = createTerminalManager();
    const terminal = manager.start({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    await terminal.exited;

    const abort = new AbortController();
    await expect(
      cancelRun({ pids: [], ptyIds: [terminal.id], abort, terminals: manager }, 500),
    ).resolves.toBeUndefined();
  });
});
