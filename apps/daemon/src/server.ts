import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEALTHZ_BODY, ROUTES, type DaemonHandle, type DaemonOptions, type RouteSpec } from "@dem/protocol";
import { bearerFrom, isAllowedHost, isAllowedOrigin, mintToken, tokenMatches, writeTokenFile } from "./auth.js";

/**
 * The local daemon (SPEC section 21; tests SEC-001, SEC-002).
 *
 * Request order matters and is deliberate:
 *
 *   1. Host      — reject a rebound hostname before anything else runs
 *   2. Origin    — reject a foreign browser origin before touching the token,
 *                  so a hostile page learns nothing about token validity
 *   3. Auth      — every route, event streams included
 *   4. Handler
 *
 * `/healthz` skips 3 and returns only liveness.
 */

function matchRoute(method: string, pathname: string): RouteSpec | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pattern = "^" + route.path.replace(/:[^/]+/g, "[^/]+") + "$";
    if (new RegExp(pattern).test(pathname)) return route;
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Deny-by-default: no access-control-allow-origin header is ever emitted.
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const host = options.host ?? "127.0.0.1";
  const stateDir = options.stateDir ?? join(tmpdir(), "dem-state");
  const token = mintToken();
  const tokenFile = await writeTokenFile(stateDir, token);

  if (!tokenFile.restricted) {
    // Loud rather than silent: the user should know their credential is
    // readable by more than themselves before they rely on this.
    console.warn(
      `[dem] warning: token file could not be restricted (${tokenFile.detail}). ` +
        `Any local process able to read ${tokenFile.path} can drive this daemon.`,
    );
  }

  const server = createServer();
  let selfOrigin = "";
  let boundPort = 0;

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", selfOrigin);
    const route = matchRoute(req.method ?? "GET", url.pathname);

    if (!isAllowedHost(req.headers.host, boundPort)) {
      send(res, 403, { error: "forbidden", reason: "host_not_allowed" });
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, selfOrigin)) {
      send(res, 403, { error: "forbidden", reason: "origin_not_allowed" });
      return;
    }
    if (!route) {
      send(res, 404, { error: "not_found" });
      return;
    }

    if (route.authenticated) {
      const presented = bearerFrom(req.headers.authorization);
      if (presented === null || !tokenMatches(presented, token)) {
        send(res, 401, { error: "unauthenticated" });
        return;
      }
    }

    handle(route, url, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      selfOrigin = `http://${host}:${boundPort}`;
      resolve();
    });
  });

  return {
    url: selfOrigin,
    token,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Route handlers. Only what Phase 1 step 2 owns is answered; the rest reports
 * 501 until its own test turns red and gets implemented in order. Returning a
 * plausible empty result here would turn a later suite green without a module
 * behind it.
 */
function handle(route: RouteSpec, _url: URL, res: ServerResponse): void {
  switch (route.path) {
    case "/healthz":
      send(res, 200, HEALTHZ_BODY);
      return;
    case "/models":
      // No provider adapter exists yet, so the honest answer is an empty list.
      send(res, 200, { models: [] });
      return;
    case "/tools":
      send(res, 200, { tools: [] });
      return;
    default:
      send(res, 501, { error: "not_implemented", route: route.path });
      return;
  }
}
