import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Local daemon credentials and browser-origin checks (SPEC section 21).
 *
 * `localhost` is not a boundary. Every process on the machine can reach the
 * port, and a page in the user's browser can try. This daemon patches files
 * and runs shells, so the checks here are the whole perimeter.
 */

/** Minted fresh on every daemon start, so a leaked token dies with the process. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenFilePath(stateDir: string): string {
  return join(stateDir, "daemon.token");
}

export interface TokenFileResult {
  path: string;
  /** False when the OS would not let us restrict the file; the caller warns. */
  restricted: boolean;
  detail: string;
}

/**
 * Persist the token so a CLI in another terminal can authenticate.
 *
 * POSIX gets 0600. Windows needs an explicit ACL: chmod is close to a no-op
 * there, and the default inherited ACL can include groups beyond the owner.
 * A failure to restrict is reported rather than swallowed — the caller
 * decides, and the user is told what protection they actually have.
 */
export async function writeTokenFile(
  stateDir: string,
  token: string,
): Promise<TokenFileResult> {
  await mkdir(stateDir, { recursive: true });
  const path = tokenFilePath(stateDir);
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);

  if (process.platform !== "win32") {
    return { path, restricted: true, detail: "mode 0600" };
  }

  const user = process.env["USERNAME"];
  if (!user) {
    return { path, restricted: false, detail: "USERNAME unset; ACL not applied" };
  }
  try {
    // /inheritance:r drops inherited entries; /grant:r replaces rather than adds.
    await exec("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`]);
    return { path, restricted: true, detail: `ACL limited to ${user}` };
  } catch (err) {
    return {
      path,
      restricted: false,
      detail: `icacls failed: ${(err as Error).message}`,
    };
  }
}

/** Compare in constant time so the daemon is not a token-guessing oracle. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Defeat DNS rebinding: a hostile page points its own domain at 127.0.0.1 and
 * then talks to the daemon as a same-origin caller. The connection is genuinely
 * from loopback, so only the Host header reveals the deception.
 */
export function isAllowedHost(host: string | undefined, boundPort: number): boolean {
  if (!host) return false;
  const match = /^(.+?)(?::(\d+))?$/.exec(host.trim());
  if (!match) return false;

  const name = (match[1] ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  const port = match[2];

  // An explicit port must be ours. A missing port would mean 80/443, never us.
  if (port === undefined || Number(port) !== boundPort) return false;

  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * CORS deny-by-default. Only the daemon's own origin is ever allowed, so a
 * browser page on any other origin cannot read a response even if it somehow
 * carries a valid token.
 */
export function isAllowedOrigin(origin: string | undefined, selfOrigin: string): boolean {
  // No Origin header at all is a non-browser client: CLI, curl, an SDK.
  if (origin === undefined) return true;
  if (origin === "null") return false;
  return origin === selfOrigin;
}
