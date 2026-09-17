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
 * A workspace with a file inside it, a file outside it, and a symlink from
 * inside pointing out — the three shapes the path guard has to distinguish.
 */
export interface EscapeFixture {
  root: string;
  workspace: string;
  insideFile: string;
  outsideFile: string;
  /** Path inside the workspace that resolves outside it. */
  symlinkedEscape: string;
  /** True when the OS let us create the symlink (Windows may not). */
  symlinkCreated: boolean;
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

  const symlinkedEscape = join(workspace, "escape.txt");
  let symlinkCreated = false;
  try {
    await symlink(outsideFile, symlinkedEscape, "file");
    symlinkCreated = true;
  } catch {
    // Unprivileged Windows without Developer Mode cannot create symlinks.
    // The traversal assertions still run; the symlink case is skipped.
  }

  return { root, workspace, insideFile, outsideFile, symlinkedEscape, symlinkCreated };
}
