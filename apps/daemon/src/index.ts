/**
 * Local daemon (SPEC section 21; tests SEC-001, SEC-002).
 *
 * Loopback bind, a bearer credential minted per start, Host and Origin
 * validation, CORS deny-by-default. Every route is authenticated including
 * the SSE event stream: `localhost` is not a security boundary, and a
 * read-only endpoint still hands out conversation content and file excerpts.
 */

export { startDaemon } from "./server.js";
export {
  bearerFrom,
  isAllowedHost,
  isAllowedOrigin,
  mintToken,
  tokenFilePath,
  tokenMatches,
  writeTokenFile,
} from "./auth.js";
export type { TokenFileResult } from "./auth.js";
