import { describe, expect, it } from "vitest";
import { createToolRegistry, execCommand, runToolCall } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * What a tool tells the model when it found nothing (SPEC §21.1).
 *
 * Measured from a real session. Asked to analyse this TypeScript project, an
 * 8B model called `glob {"pattern":"*.py"}`, got back the empty string, and
 * called it again — identically. Twenty times, then the round budget ended the
 * turn with nothing to show for it.
 *
 * The cause was worse than a bad message: `rg` is not installed on that
 * machine, the spawn error was discarded, and a missing binary produced the
 * same empty string as a search that matched nothing. Three outcomes, one
 * appearance, and only one of them a reason to try a different pattern.
 */

const policy = {
  mode: "ASK" as const,
  sandbox: "UNAVAILABLE" as const,
  taint: "CLEAN" as const,
  denyCommands: [],
  approvedCallIds: new Set<string>(),
};

describe("A command that never ran is not a command that found nothing", () => {
  it("reports a binary that is not installed", async () => {
    await withTempDir(async (dir) => {
      const result = await execCommand("definitely-not-a-real-binary-xyz", [], { cwd: dir });

      expect(result.failedToStart).toBe(true);
      expect(result.stderr).toContain("definitely-not-a-real-binary-xyz");
    });
  });

  it("does not mark a command that ran and printed nothing", async () => {
    await withTempDir(async (dir) => {
      const result = await execCommand(process.execPath, ["-e", ""], { cwd: dir });

      expect(result.failedToStart).toBeUndefined();
      expect(result.stdout).toBe("");
      expect(result.code).toBe(0);
    });
  });
});

describe("A search that found nothing says so", () => {
  /**
   * `rg` may or may not be installed where these run, and both cases are
   * correct behaviour — so both are asserted, by asking which one happened.
   */
  it("either lists matches, says there are none, or says ripgrep is missing", async () => {
    await withTempDir(async (dir) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "a.ts"), "hello");

      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "glob", arguments: { pattern: "*.py" } },
        policy,
      );

      if (result.error) {
        // No ripgrep: it must say which program, and not pretend to have
        // searched.
        expect(result.error).toMatch(/ripgrep|rg/i);
      } else {
        // Ripgrep present and nothing matched: it must say so, and name the
        // pattern, because "no matches" for a pattern the model has forgotten
        // is another thing it cannot act on.
        expect(String(result.output)).toMatch(/^no /i);
        expect(String(result.output)).toContain("*.py");
      }
    });
  });

  it("never returns the empty string for a search", async () => {
    // The whole bug in one assertion.
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "grep", arguments: { pattern: "nothingmatchesthis" } },
        policy,
      );
      expect(result.output === "" && !result.error).toBe(false);
    });
  });
});

describe("A tool call that cannot be run says why, and by whom", () => {
  it("names the tools that exist when the name is not one of them", async () => {
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "frobnicate", arguments: {} },
        policy,
      );

      expect(result.executed).toBe(false);
      expect(result.error).toContain("frobnicate");
      expect(result.error).toContain("glob");
      expect(result.error).toContain("read");
    });
  });

  it("names the tool and its parameters when an argument is missing", async () => {
    // From the session: the model called `hash` with no arguments and was told
    // "path must be a string" - which of six tools said that, and what is the
    // path for? It went back to guessing.
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "hash", arguments: {} },
        policy,
      );

      expect(result.executed).toBe(false);
      expect(result.error).toContain("hash");
      expect(result.error).toContain("path");
    });
  });
});

describe("Search works without ripgrep", () => {
  /**
   * SPEC §29 says to borrow mature tools rather than build them, and ripgrep
   * is the right thing to borrow. But a borrowed tool that is not installed is
   * worse than a small owned one: on the machine this was found on, `rg` is
   * not on PATH, so two of six tools returned nothing on every call.
   *
   * These run whichever implementation is present, and assert the result — so
   * they pass on a machine with ripgrep and on one without, which is the point.
   */
  it("finds files by pattern", async () => {
    await withTempDir(async (dir) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "export const a = 1;");
      await writeFile(join(dir, "src", "b.js"), "module.exports = 2;");

      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "glob", arguments: { pattern: "*.ts" } },
        policy,
      );

      expect(result.error).toBeUndefined();
      expect(String(result.output)).toContain("a.ts");
      expect(String(result.output)).not.toContain("b.js");
    });
  });

  it("finds text inside files, with line numbers", async () => {
    await withTempDir(async (dir) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "notes.txt"), "first\nNEEDLE here\nthird");

      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "grep", arguments: { pattern: "NEEDLE" } },
        policy,
      );

      expect(result.error).toBeUndefined();
      expect(String(result.output)).toContain("NEEDLE");
      expect(String(result.output)).toContain(":2:");
    });
  });

  it("says so when nothing matched, either way", async () => {
    await withTempDir(async (dir) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "a.ts"), "nothing of interest");

      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "glob", arguments: { pattern: "*.py" } },
        policy,
      );

      expect(result.error).toBeUndefined();
      expect(String(result.output)).toMatch(/^no /i);
      expect(String(result.output)).toContain("*.py");
    });
  });

  it("does not walk into node_modules", async () => {
    // The floor has to stay a floor: a walker that descends into a dependency
    // tree is slower than useless.
    await withTempDir(async (dir) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "x");
      await writeFile(join(dir, "mine.ts"), "x");

      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        { id: "1", name: "glob", arguments: { pattern: "*.ts" } },
        policy,
      );

      expect(String(result.output)).toContain("mine.ts");
      expect(String(result.output)).not.toContain("node_modules");
    });
  });
});
