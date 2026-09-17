import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { StaleWrite } from "@dem/protocol";
import { resolveWorkspacePath } from "../policy/path-guard.js";

/**
 * Structured patching (invariant 26, test RUN-003).
 *
 * v0.1 exposes no unrestricted `write`. Every mutation arrives as an explicit
 * op with the hash the caller believed the file had, so a write that would
 * clobber an unseen change fails loudly instead of silently winning.
 *
 * `update` carries whole-file content for now. Hunk-level editing belongs with
 * the model-facing tool surface and lands there; the conflict safety this
 * module exists for comes from `expectedHash`, not from the diff format, so
 * deferring the format costs nothing here.
 */

export type PatchOp =
  | { kind: "create"; path: string; content: string }
  | { kind: "update"; path: string; expectedHash: string; content: string }
  | { kind: "delete"; path: string; expectedHash: string };

export interface PatchResult {
  path: string;
  applied: boolean;
  /** Hash after the op. Empty for a delete. */
  newHash: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(absolutePath: string): Promise<string> {
  try {
    return hashContent(await readFile(absolutePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Apply a batch atomically.
 *
 * Every op is validated against disk before any of them is written, and the
 * prior contents are held so a mid-batch failure can be undone. A half-applied
 * patch is the worst outcome available: the workspace ends up in a state
 * neither the model nor the user has ever seen, and the transcript describes
 * something that did not happen.
 */
export async function applyPatch(
  workspaceRoot: string,
  ops: readonly PatchOp[],
): Promise<PatchResult[]> {
  const planned: Array<{ op: PatchOp; realPath: string; previous: string | null }> = [];

  // Phase 1 — resolve and verify everything. Nothing has been written yet.
  for (const op of ops) {
    const { realPath } = await resolveWorkspacePath(workspaceRoot, op.path);
    const previous = await readIfExists(realPath);

    if (op.kind !== "create") {
      const actual = previous === null ? "" : hashContent(previous);
      if (actual !== op.expectedHash) {
        throw new StaleWrite(op.path, op.expectedHash, actual);
      }
    }

    planned.push({ op, realPath, previous });
  }

  // Phase 2 — write. On any failure, restore what phase 1 recorded.
  const done: typeof planned = [];
  try {
    for (const entry of planned) {
      const { op, realPath } = entry;
      if (op.kind === "delete") {
        await rm(realPath, { force: true });
      } else {
        await mkdir(dirname(realPath), { recursive: true });
        await writeFile(realPath, op.content, "utf8");
      }
      done.push(entry);
    }
  } catch (err) {
    await rollback(done);
    throw err;
  }

  return planned.map(({ op }) => ({
    path: op.path,
    applied: true,
    newHash: op.kind === "delete" ? "" : hashContent(op.content),
  }));
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function rollback(
  applied: ReadonlyArray<{ realPath: string; previous: string | null }>,
): Promise<void> {
  for (const { realPath, previous } of [...applied].reverse()) {
    try {
      if (previous === null) await rm(realPath, { force: true });
      else await writeFile(realPath, previous, "utf8");
    } catch {
      // Best effort. A rollback failure is reported by the original error
      // rather than replaced by it, which would hide what actually went wrong.
    }
  }
}
