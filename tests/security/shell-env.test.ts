import { describe, expect, it } from "vitest";
import { execCommand } from "@dem/engine";

/**
 * SEC-005 (integration) — invariants 6 and 7.
 *
 * The unit test checks `sanitizeChildEnv` as a function. This one spawns a
 * real process and asks it what it can see. Those are different claims: a
 * sanitiser that is correct but never wired into spawn protects nothing, and
 * that gap is invisible to a unit test.
 */

const PRINT_ENV = "console.log(JSON.stringify(process.env))";

describe("SEC-005: a real child process cannot see provider secrets", () => {
  it("does not inherit a secret present in this process", async () => {
    const key = "OPENAI_API_KEY";
    const value = "sk-live-must-not-leak";
    const previous = process.env[key];
    process.env[key] = value;

    try {
      const result = await execCommand(process.execPath, ["-e", PRINT_ENV], { cwd: process.cwd() });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(value);

      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      expect(childEnv).not.toHaveProperty(key);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("still gives the child what it needs to run at all", async () => {
    const result = await execCommand(process.execPath, ["-e", PRINT_ENV], { cwd: process.cwd() });
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    // Without PATH, most tools a coding agent runs cannot be found.
    expect(childEnv["PATH"] ?? childEnv["Path"]).toBeTruthy();
  });
});

describe("SEC-005: shell execution is bounded", () => {
  it("stops a command that outruns its timeout", async () => {
    const result = await execCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeoutMs: 300 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("stops when the caller aborts", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const result = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      signal: abort.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it("returns promptly after an abort rather than waiting on tree cleanup", async () => {
    // On a managed Windows host `taskkill /t /f` was measured at a consistent
    // ~3.8s. Waiting for it would stall every cancel and timeout by that much,
    // so the tree walk is fired without being awaited. This bound is what
    // stops someone reintroducing the wait later.
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 100);

    await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      signal: abort.signal,
    });

    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("caps captured output so a runaway command cannot exhaust memory", async () => {
    const result = await execCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(5_000_000))"],
      { cwd: process.cwd(), maxOutputBytes: 1000 },
    );
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
  });

  it("redacts known secret values from captured output", async () => {
    // A command that prints a secret it was legitimately given must not put
    // that value into a transcript the model and the audit log will read.
    const result = await execCommand(
      process.execPath,
      ["-e", "console.log('token is sk-live-abc123')"],
      { cwd: process.cwd(), redactValues: ["sk-live-abc123"] },
    );
    expect(result.stdout).not.toContain("sk-live-abc123");
    expect(result.stdout).toContain("token is");
  });
});
