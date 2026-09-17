import { NotImplemented } from "@dem/protocol";

/**
 * Workspace path guard (invariant 8, tests SEC-003 / SEC-004).
 *
 * Checked by canonical/real path, never by string prefix: a string prefix
 * check passes `/work/../etc/passwd` and follows a symlink straight out of
 * the workspace.
 */
export interface PathGuardResult {
  /** Absolute, symlink-resolved path inside the workspace. */
  realPath: string;
}

/**
 * Resolve a requested path against the workspace root.
 * Throws PolicyViolation when the resolved real path escapes the workspace.
 */
export function resolveWorkspacePath(
  _workspaceRoot: string,
  _requested: string,
): Promise<PathGuardResult> {
  throw new NotImplemented("resolveWorkspacePath", "SEC-003, SEC-004");
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

export function isProtectedPath(_relativePath: string): boolean {
  throw new NotImplemented("isProtectedPath", "SEC-003");
}
