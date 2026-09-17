import { describe, expect, it } from "vitest";
import { main, type Io } from "@dem/cli";

/**
 * Acceptance: the CLI is a shell over the daemon, not a second agent core
 * (plan 4.5). These tests hold that boundary: everything the CLI prints has
 * to have come from the session event log.
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

describe("dem CLI", () => {
  it("prints help and exits cleanly with no arguments", async () => {
    const io = capture();
    expect(await main([], io)).toBe(0);
    expect(io.stdout).toContain("dem run <prompt>");
  });

  it("says the permission ceiling is ASK, so nobody expects AUTO in v0.1", async () => {
    const io = capture();
    await main(["help"], io);
    expect(io.stdout).toContain("ASK");
  });

  it("rejects an unknown command with a non-zero status", async () => {
    const io = capture();
    expect(await main(["frobnicate"], io)).toBe(2);
    expect(io.stderr).toContain("unknown command");
  });

  it("requires a prompt for run", async () => {
    const io = capture();
    expect(await main(["run"], io)).toBe(2);
  });

  it("runs a prompt end to end and prints the streamed answer", async () => {
    const io = capture();
    expect(await main(["run", "hello", "there"], io)).toBe(0);
    // FakeProvider's derived reply echoes the prompt back deterministically.
    expect(io.stdout).toContain("you said: hello there");
    // The session id is surfaced so the run can be inspected later.
    expect(io.stderr).toMatch(/session ses_[0-9a-f]+/);
  });

  it("lists the provider the daemon actually reaches", async () => {
    const io = capture();
    expect(await main(["models"], io)).toBe(0);
    expect(io.stdout).toContain("LOCAL");
    expect(io.stdout).toContain("fake");
    expect(io.stdout).toContain("text.generate");
  });
});
