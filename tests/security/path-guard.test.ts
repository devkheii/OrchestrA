import { describe, expect, it } from "vitest";
import { PolicyViolation } from "@dem/protocol";
import { isProtectedPath, resolveWorkspacePath } from "@dem/engine";
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

describe("SEC-003: paths under secret policy are flagged", () => {
  it("flags credential files wherever they sit in the tree", () => {
    for (const p of [
      ".env",
      ".env.production",
      "config/app.pem",
      "certs/server.key",
      ".ssh/id_rsa",
      "nested/deep/.aws/credentials",
      ".npmrc",
    ]) {
      expect(isProtectedPath(p), `${p} should be protected`).toBe(true);
    }
  });

  it("does not flag ordinary source files", () => {
    for (const p of ["src/auth.ts", "README.md", "environment.md", "keys.md", "src/env.ts"]) {
      expect(isProtectedPath(p), `${p} should not be protected`).toBe(false);
    }
  });

  it("matches regardless of path separator, since Windows uses both", () => {
    expect(isProtectedPath(".ssh\\id_rsa")).toBe(true);
    expect(isProtectedPath("nested\\.env")).toBe(true);
  });
});

describe("SEC-004: symlink escape is rejected", () => {
  it("rejects every link inside the workspace that resolves outside it", async () => {
    await withTempDir(async (root) => {
      // Throws if no link kind could be created, rather than passing untested:
      // an unexercised guard is not a guard.
      const fx = await makeEscapeFixture(root);

      for (const escape of fx.escapes) {
        await expect(
          resolveWorkspacePath(fx.workspace, escape.path),
          `${escape.kind} escape via ${escape.path}`,
        ).rejects.toBeInstanceOf(PolicyViolation);
      }
    });
  });

  it("rejects a file that does not exist yet behind a link that leaves the workspace", async () => {
    // The agent creates files. A guard that only checks existing paths would
    // happily write the new file on the far side of the link.
    await withTempDir(async (root) => {
      const fx = await makeEscapeFixture(root);
      const dirEscape = fx.escapes.find((e) => e.kind === "junction");
      if (!dirEscape) return; // POSIX: covered by the symlink case above

      await expect(
        resolveWorkspacePath(fx.workspace, "escape-dir/not-created-yet.txt"),
      ).rejects.toBeInstanceOf(PolicyViolation);
    });
  });
});
