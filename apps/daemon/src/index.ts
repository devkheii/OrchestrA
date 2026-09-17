import { NotImplemented } from "@dem/protocol";
import type { DaemonHandle, DaemonOptions } from "@dem/protocol";

/**
 * Local daemon (SPEC section 21; tests SEC-001, SEC-002).
 *
 * Loopback bind, a bearer credential minted per start, Host and Origin
 * validation, CORS deny-by-default. Every route is authenticated including
 * the SSE event stream: `localhost` is not a security boundary, and a
 * read-only endpoint still hands out conversation content and file excerpts.
 */

export function startDaemon(_options: DaemonOptions): Promise<DaemonHandle> {
  throw new NotImplemented("startDaemon", "SEC-001, SEC-002");
}

/**
 * Validate the Host header against the bound address to defeat DNS
 * rebinding, where a hostile page resolves its own domain to 127.0.0.1 and
 * then speaks to the daemon as a same-origin caller.
 */
export function isAllowedHost(_host: string | undefined, _boundPort: number): boolean {
  throw new NotImplemented("isAllowedHost", "SEC-002");
}

/** CORS deny-by-default: only the daemon's own origin is ever allowed. */
export function isAllowedOrigin(_origin: string | undefined, _selfOrigin: string): boolean {
  throw new NotImplemented("isAllowedOrigin", "SEC-002");
}

/**
 * Where the bearer token is stored: 0600 on POSIX, current-user-only ACL on
 * Windows. Never placed in a query string.
 */
export function tokenFilePath(_stateDir: string): string {
  throw new NotImplemented("tokenFilePath", "SEC-001");
}
