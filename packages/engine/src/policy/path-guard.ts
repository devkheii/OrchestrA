import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PolicyViolation } from "@dem/protocol";

/**
 * Workspace path guard (invariant 8, tests SEC-003 / SEC-004).
 *
 * Containment is decided on canonical real paths. A string-prefix check on the
 * requested path passes `workspace/../etc/passwd`, follows a symlink straight
 * out of the tree, and accepts `/work-evil` as being inside `/work` — three
 * separate ways the same shortcut fails.
 */

export interface PathGuardResult {
  /** Absolute, symlink-resolved path inside the workspace. */
  realPath: string;
}

/** Windows compares paths case-insensitively; POSIX does not. */
const CASE_INSENSITIVE = process.platform === "win32";

function sameOrInside(child: string, parent: string): boolean {
  const a = CASE_INSENSITIVE ? child.toLowerCase() : child;
  const b = CASE_INSENSITIVE ? parent.toLowerCase() : parent;
  // The trailing separator is what stops `/work-evil` matching `/work`.
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Resolve the deepest ancestor that exists, then re-attach the missing tail.
 *
 * A path that does not exist yet still has to be checked — the agent creates
 * files — and `realpath` fails outright on a missing path. Resolving the
 * existing prefix means a symlinked parent directory cannot smuggle the new
 * file out of the workspace.
 */
async function realpathOfNearestAncestor(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return target;
      }
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  requested: string,
): Promise<PathGuardResult> {
  // The root is resolved too: /tmp is a symlink on macOS, and Windows can hand
  // back an 8.3 short name. Comparing an unresolved root to a resolved child
  // rejects legitimate paths and, worse, invites a loosened comparison later.
  const realRoot = await realpathOfNearestAncestor(resolve(workspaceRoot));

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested);
  const realPath = await realpathOfNearestAncestor(candidate);

  if (!sameOrInside(realPath, realRoot)) {
    throw new PolicyViolation(
      `path escapes workspace: ${requested} resolves to ${realPath}, outside ${realRoot}`,
      8,
    );
  }

  return { realPath };
}

/** Paths under secret policy regardless of workspace membership (plan 4.7). */
export const PROTECTED_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".ssh/**",
  ".aws/credentials",
  ".npmrc",
];

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/" || part === "**") return "(?:.*/)?";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  // Anchored at a path segment boundary: `keys.md` must not match `*.key`, but
  // `nested/deep/.env` must match `.env`.
  return new RegExp(`(^|/)${escaped}$`, CASE_INSENSITIVE ? "i" : "");
}

const COMPILED = PROTECTED_PATTERNS.map(patternToRegExp);

export function isProtectedPath(relativePath: string): boolean {
  // Windows accepts both separators; normalise so one pattern set covers both.
  const normalised = relativePath.replace(/\\/g, "/");
  return COMPILED.some((re) => re.test(normalised));
}
