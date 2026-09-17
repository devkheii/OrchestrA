import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BudgetExceeded, StaleWrite } from "@dem/protocol";
import type { Budget, BudgetUsage } from "@dem/engine";
import { applyPatch, assertWithinBudget, hashFile } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * RUN-002 — invariant 28.
 *
 * The check runs before execution. A budget enforced afterwards has already
 * spent the money it existed to withhold, which matters most for the mode
 * that calls two models per question.
 */

const zero: BudgetUsage = {
  inputTokens: 0,
  outputTokens: 0,
  wallTimeMs: 0,
  remoteCost: 0,
  rounds: 0,
  counterexampleExecutions: 0,
};

describe("RUN-002: budget stops work before it is spent", () => {
  it("allows a call that fits", () => {
    const budget: Budget = { maxRemoteCost: 1.0 };
    expect(() =>
      assertWithinBudget(budget, { ...zero, remoteCost: 0.4 }, { remoteCost: 0.3 }),
    ).not.toThrow();
  });

  it("refuses a call whose projected cost would exceed the ceiling", () => {
    const budget: Budget = { maxRemoteCost: 1.0 };
    expect(() =>
      assertWithinBudget(budget, { ...zero, remoteCost: 0.9 }, { remoteCost: 0.3 }),
    ).toThrow(BudgetExceeded);
  });

  it("refuses on the projection, not only once already over", () => {
    // Usage is still under the ceiling; the next call is what breaches it.
    const budget: Budget = { maxInputTokens: 1000 };
    expect(() =>
      assertWithinBudget(budget, { ...zero, inputTokens: 900 }, { inputTokens: 200 }),
    ).toThrow(BudgetExceeded);
  });

  it("enforces round and wall-time ceilings", () => {
    expect(() => assertWithinBudget({ maxRounds: 2 }, { ...zero, rounds: 2 }, { rounds: 1 })).toThrow(
      BudgetExceeded,
    );
    expect(() =>
      assertWithinBudget({ maxWallTimeMs: 1000 }, { ...zero, wallTimeMs: 900 }, { wallTimeMs: 200 }),
    ).toThrow(BudgetExceeded);
  });

  it("treats an unset ceiling as unlimited rather than zero", () => {
    expect(() => assertWithinBudget({}, { ...zero, remoteCost: 99 }, { remoteCost: 99 })).not.toThrow();
  });
});

/**
 * RUN-003 — invariant 26.
 *
 * Two clients may attach to one session, and a background job may run while
 * the user edits. A write that silently overwrites an unseen change is a data
 * loss bug the user never gets told about.
 */

describe("RUN-003: concurrent edits are detected, not overwritten", () => {
  it("applies an update when the expected hash still matches", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "original\n");
      const hash = await hashFile(file);

      const [result] = await applyPatch(dir, [
        { kind: "update", path: "a.txt", expectedHash: hash, hunks: "patched\n" },
      ]);

      expect(result?.applied).toBe(true);
      expect(await readFile(file, "utf8")).toBe("patched\n");
    });
  });

  it("refuses an update when the file changed underneath", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "original\n");
      const staleHash = await hashFile(file);

      // Someone else writes between read and patch.
      await writeFile(file, "changed by someone else\n");

      await expect(
        applyPatch(dir, [
          { kind: "update", path: "a.txt", expectedHash: staleHash, hunks: "patched\n" },
        ]),
      ).rejects.toBeInstanceOf(StaleWrite);

      // The other writer's content survives.
      expect(await readFile(file, "utf8")).toBe("changed by someone else\n");
    });
  });

  it("refuses a delete when the file changed underneath", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a.txt");
      await writeFile(file, "original\n");
      const staleHash = await hashFile(file);
      await writeFile(file, "changed\n");

      await expect(
        applyPatch(dir, [{ kind: "delete", path: "a.txt", expectedHash: staleHash }]),
      ).rejects.toBeInstanceOf(StaleWrite);
    });
  });

  it("applies a multi-file patch atomically: one stale op reverts the batch", async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, "a.txt");
      const b = join(dir, "b.txt");
      await writeFile(a, "a\n");
      await writeFile(b, "b\n");
      const hashA = await hashFile(a);
      const staleB = await hashFile(b);
      await writeFile(b, "b changed\n");

      await expect(
        applyPatch(dir, [
          { kind: "update", path: "a.txt", expectedHash: hashA, hunks: "a patched\n" },
          { kind: "update", path: "b.txt", expectedHash: staleB, hunks: "b patched\n" },
        ]),
      ).rejects.toBeInstanceOf(StaleWrite);

      // a.txt must not be left half-applied.
      expect(await readFile(a, "utf8")).toBe("a\n");
    });
  });
});
