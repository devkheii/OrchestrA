/**
 * Daemon HTTP surface (SPEC section 21, plan 4.1).
 *
 * Every route here requires authentication, including the event stream: a
 * read-only endpoint still exposes conversation content, file excerpts and
 * tool output (invariant 4).
 */

import type { Provider } from "./provider.js";

export interface RouteSpec {
  method: "GET" | "POST";
  /** Path pattern with `:param` segments. */
  path: string;
  /**
   * False only for the optional /healthz probe, which must reveal nothing
   * beyond coarse liveness.
   */
  authenticated: boolean;
  mutating: boolean;
}

export const ROUTES: readonly RouteSpec[] = [
  { method: "POST", path: "/sessions", authenticated: true, mutating: true },
  { method: "POST", path: "/sessions/:id/messages", authenticated: true, mutating: true },
  { method: "GET", path: "/sessions/:id/events", authenticated: true, mutating: false },
  { method: "POST", path: "/sessions/:id/approve", authenticated: true, mutating: true },
  { method: "POST", path: "/sessions/:id/cancel", authenticated: true, mutating: true },
  { method: "GET", path: "/models", authenticated: true, mutating: false },
  { method: "GET", path: "/tools", authenticated: true, mutating: false },
  { method: "GET", path: "/memory", authenticated: true, mutating: false },
  { method: "GET", path: "/healthz", authenticated: false, mutating: false },
];

/** The only body /healthz may ever return (plan 4.1). */
export const HEALTHZ_BODY = { status: "ok" } as const;

/** Keys that must never appear in a /healthz response. */
export const HEALTHZ_FORBIDDEN_KEYS: readonly string[] = [
  "version",
  "sessions",
  "sessionCount",
  "workspace",
  "model",
  "models",
  "user",
  "token",
  "uptime",
  "pid",
];

export interface DaemonOptions {
  /** Loopback only by default. */
  host?: string;
  port?: number;
  workspace: string;
  /** Where the bearer token file lives. Created 0600 / current-user ACL. */
  stateDir?: string;
  /** SQLite path. Defaults to `<stateDir>/app.db`. */
  dbPath?: string;
  /**
   * Text provider backing this daemon. Injected rather than resolved from
   * config so tests can run the whole API against FakeProvider with no model
   * present.
   */
  provider?: Provider;
  /** Tool rounds before the loop gives up. Guards against a model that loops. */
  maxRounds?: number;
}

export interface DaemonHandle {
  url: string;
  /** Bearer credential minted at startup, regenerated every start. */
  token: string;
  close(): Promise<void>;
}
