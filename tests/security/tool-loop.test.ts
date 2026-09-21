import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCall } from "@dem/protocol";
import { createToolRegistry, runToolCall } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-020 — invariant 36.
 *
 * Every tool call is decided by the Permission Broker before it runs, and the
 * decision is recorded. There is no path from a model's output to an effect
 * that skips this step.
 *
 * This is the invariant the whole harness is built around, and it is the one
 * most easily lost to convenience: an internal caller that "already knows" a
 * call is safe, a retry path that reuses a prior decision, a tool added later
 * that goes straight to its implementation. So the registry has no execute
 * method that takes a call without a decision — the check is not a step the
 * caller performs, it is the only way in.
 */

const ASK = { mode: "ASK", taint: "CLEAN", sandbox: "UNAVAILABLE" } as const;
const READ_ONLY = { ...ASK, mode: "READ_ONLY" } as const;

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

describe("SEC-020: no tool runs without a broker decision", () => {
  it("records a decision for every call, allowed or not", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.txt"), "hello\n");
      const registry = createToolRegistry({ workspace: dir });

      const result = await runToolCall(registry, call("read", { path: "a.txt" }), ASK);
      expect(result.decision).toBeDefined();
      expect(result.decision.outcome).toBe("auto");
      expect(result.decision.rule).toBeTruthy();
    });
  });

  it("does not execute when the broker denies", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.txt"), "original\n");
      const registry = createToolRegistry({ workspace: dir });

      const result = await runToolCall(
        registry,
        call("patch", { path: "a.txt", expectedHash: "x", content: "clobbered\n" }),
        READ_ONLY,
      );

      expect(result.decision.outcome).toBe("deny");
      expect(result.executed).toBe(false);
      // The file is the assertion that matters: a denial that still wrote
      // would pass an outcome check and fail the user.
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("original\n");
    });
  });

  it("does not execute when the broker asks and no approval was given", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.txt"), "original\n");
      const registry = createToolRegistry({ workspace: dir });

      const result = await runToolCall(
        registry,
        call("shell", { command: "echo pwned" }),
        ASK,
      );

      expect(result.decision.outcome).toBe("ask");
      expect(result.executed).toBe(false);
      expect(result.needsApproval).toBe(true);
    });
  });

  it("executes an ask-gated call once approval is supplied", async () => {
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(registry, call("shell", { command: "echo approved" }), {
        ...ASK,
        approved: true,
      });

      expect(result.executed).toBe(true);
      expect((result.output as { stdout: string }).stdout).toContain("approved");
    });
  });

  it("refuses a tool the registry does not have, rather than guessing", async () => {
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(registry, call("rm_rf", { path: "/" }), ASK);
      expect(result.executed).toBe(false);
      expect(result.decision.outcome).toBe("deny");
      // The rule is the machine-readable part and is asserted as such; the
      // message is written for the model and says what tools exist instead,
      // because "unknown tool: rm_rf" leaves it with nothing but another guess.
      expect(result.decision.rule).toContain("unknown tool");
      expect(result.error).toContain("rm_rf");
    });
  });

  it("maps every registered tool to a permission action, leaving none unclassified", () => {
    // A tool with no action would have nothing for the broker to decide on,
    // and the obvious repair is to let it through. Checked here so a new tool
    // cannot be added without choosing what it is.
    const registry = createToolRegistry({ workspace: "." });
    for (const tool of registry.list()) {
      expect(tool.action, `${tool.name} has no permission action`).toBeTruthy();
    }
  });
});

describe("SEC-020: the guard cannot be walked around", () => {
  it("still asks about a destructive command standing on its own", async () => {
    // Visible on its own, so the user can actually decide. It is the hiding
    // that is refused, not the command.
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(registry, call("shell", { command: "rm -rf build" }), ASK);
      expect(result.decision.outcome).toBe("ask");
      expect(result.needsApproval).toBe(true);
    });
  });

  it("re-decides on every call rather than reusing an earlier outcome", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.txt"), "original\n");
      const registry = createToolRegistry({ workspace: dir });

      // Approved once...
      const first = await runToolCall(registry, call("shell", { command: "echo one" }), {
        ...ASK,
        approved: true,
      });
      expect(first.executed).toBe(true);

      // ...does not carry to the next call.
      const second = await runToolCall(registry, call("shell", { command: "echo two" }), ASK);
      expect(second.executed).toBe(false);
    });
  });

  it("still enforces the workspace boundary on an approved call", async () => {
    // Approval answers "may this kind of thing happen", not "is this path
    // allowed". The path guard runs regardless (invariant 8).
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        call("read", { path: "../outside-the-workspace.txt" }),
        { ...ASK, approved: true },
      );
      expect(result.executed).toBe(false);
      expect(result.error).toMatch(/workspace/i);
    });
  });

  it("refuses a destructive segment hidden inside a compound command", async () => {
    await withTempDir(async (dir) => {
      const registry = createToolRegistry({ workspace: dir });
      const result = await runToolCall(
        registry,
        call("shell", { command: "echo safe && rm -rf /" }),
        { ...ASK, approved: true },
      );
      // Denied outright, not merely asked about. Approving `rm -rf build` is a
      // decision about `rm -rf build`; approving `echo safe && rm -rf /` is a
      // decision the user believes they made about `echo safe`.
      expect(result.executed).toBe(false);
      expect(result.decision.outcome).toBe("deny");
    });
  });
});
