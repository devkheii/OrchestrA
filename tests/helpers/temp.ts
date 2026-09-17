import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run `fn` against a fresh temp directory, removed afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dem-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A workspace with a file inside it, a file outside it, and at least one link
 * from inside that resolves out — the shapes the path guard has to tell apart.
 *
 * Two link kinds are attempted because Windows treats them differently:
 * a file symlink needs Developer Mode or elevation, while a *directory
 * junction* needs neither. The junction is not a fallback for test
 * convenience — it is the escape an unprivileged process on Windows can
 * actually create, so it is the one that most needs covering there.
 */
export interface EscapeFixture {
  root: string;
  workspace: string;
  insideFile: string;
  outsideFile: string;
  /**
   * Paths inside the workspace that resolve outside it. At least one entry,
   * or the fixture throws rather than letting the suite pass untested.
   */
  escapes: Array<{ kind: "symlink" | "junction"; path: string }>;
}

export async function makeEscapeFixture(root: string): Promise<EscapeFixture> {
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });

  const insideFile = join(workspace, "inside.txt");
  const outsideFile = join(outside, "secret.txt");
  await writeFile(insideFile, "in\n");
  await writeFile(outsideFile, "out\n");

  const escapes: EscapeFixture["escapes"] = [];

  try {
    const link = join(workspace, "escape.txt");
    await symlink(outsideFile, link, "file");
    escapes.push({ kind: "symlink", path: "escape.txt" });
  } catch {
    // Unprivileged Windows without Developer Mode. The junction below covers it.
  }

  try {
    const link = join(workspace, "escape-dir");
    await symlink(outside, link, "junction");
    escapes.push({ kind: "junction", path: "escape-dir/secret.txt" });
  } catch {
    // POSIX has no junctions; the symlink above covers it there.
  }

  if (escapes.length === 0) {
    throw new Error(
      "no link escape could be created on this host, so SEC-004 would pass untested. " +
        "Run the suite under WSL2, or enable Developer Mode on Windows.",
    );
  }

  return { root, workspace, insideFile, outsideFile, escapes };
}
