import { describe, expect, it } from "vitest";
import { PolicyViolation } from "@dem/protocol";
import { resolveWorkspacePath } from "@dem/engine";
import { makeEscapeFixture, withTempDir } from "../helpers/temp.js";

/**
 * SEC-003 / SEC-004 — invariant 8.
 *
 * The guard compares canonical real paths. A string-prefix check passes
 * `workspace/../etc/passwd` and follows a symlink straight out of the tree,
 * which is exactly how this class of bug ships.
 */

describe("SEC-003: path traversal is rejected", () => {
  it("accepts a plain path inside the workspace", async () => {
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      const result = await resolveWorkspacePath(fx.workspace, "inside.txt");
      expect(result.realPath).toBe(fx.insideFile);
    });
  });

  it("rejects ../ traversal out of the workspace", async () => {
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      await expect(
        resolveWorkspacePath(fx.workspace, "../outside/secret.txt"),
      ).rejects.toBeInstanceOf(PolicyViolation);
    });
  });

  it("rejects an absolute path outside the workspace", async () => {
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      await expect(resolveWorkspacePath(fx.workspace, fx.outsideFile)).rejects.toBeInstanceOf(
        PolicyViolation,
      );
    });
  });

  it("rejects a sibling directory sharing the workspace name prefix", async () => {
    // `/tmp/x/workspace-evil` string-prefix-matches `/tmp/x/workspace`.
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      await expect(
        resolveWorkspacePath(fx.workspace, `${fx.workspace}-evil/file.txt`),
      ).rejects.toBeInstanceOf(PolicyViolation);
    });
  });
});

describe("SEC-004: symlink escape is rejected", () => {
  it("rejects a path inside the workspace that resolves outside it", async () => {
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      if (!fx.symlinkCreated) {
        // Recorded rather than silently passing: an untested guard is not a guard.
        expect.fail("symlink fixture unavailable on this host; run this suite under WSL2");
      }
      await expect(resolveWorkspacePath(fx.workspace, "escape.txt")).rejects.toBeInstanceOf(
        PolicyViolation,
      );
    });
  });
});
