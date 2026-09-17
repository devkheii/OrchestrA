import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEALTHZ_BODY,
  ROUTES,
  isId,
  type DaemonHandle,
  type DaemonOptions,
  type Provider,
  type RouteSpec,
  type SessionId,
} from "@dem/protocol";
import { openSessionStore, type SessionStore } from "@dem/engine";
import { FakeProvider } from "@dem/adapters";
import {
  bearerFrom,
  isAllowedHost,
  isAllowedOrigin,
  mintToken,
  tokenMatches,
  writeTokenFile,
} from "./auth.js";
import { createSession, readEvents, runMessage } from "./sessions.js";

/**
 * The local daemon (SPEC section 21; tests SEC-001, SEC-002).
 *
 * Request order is deliberate:
 *
 *   1. Host    — reject a rebound hostname before anything else runs
 *   2. Origin  — reject a foreign browser origin before touching the token, so
 *                a hostile page learns nothing about token validity
 *   3. Auth    — every route, event streams included
 *   4. Handler
 *
 * `/healthz` skips step 3 and returns only liveness.
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

const MAX_BODY_BYTES = 1_000_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded so a local process cannot exhaust memory through an open port.
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sessionIdFrom(pathname: string): SessionId | null {
  const raw = pathname.split("/")[2];
  return raw && isId(raw, "session") ? raw : null;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const host = options.host ?? "127.0.0.1";
  const stateDir = options.stateDir ?? join(tmpdir(), "dem-state");
  const provider: Provider = options.provider ?? new FakeProvider();
  const store: SessionStore = await openSessionStore(options.dbPath ?? join(stateDir, "app.db"));

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
  const inFlight = new Map<SessionId, AbortController>();
  let selfOrigin = "";
  let boundPort = 0;

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://placeholder");

      if (!isAllowedHost(req.headers.host, boundPort)) {
        send(res, 403, { error: "forbidden", reason: "host_not_allowed" });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, selfOrigin)) {
        send(res, 403, { error: "forbidden", reason: "origin_not_allowed" });
        return;
      }

      const route = matchRoute(req.method ?? "GET", url.pathname);
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

      try {
        await handle(route, req, res, url);
      } catch (err) {
        send(res, 500, { error: "internal", message: (err as Error).message });
      }
    })();
  });

  async function handle(
    route: RouteSpec,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    switch (route.path) {
      case "/healthz":
        send(res, 200, HEALTHZ_BODY);
        return;

      case "/models":
        send(res, 200, {
          models: [{ id: provider.id, capabilities: provider.capabilities() }],
        });
        return;

      case "/tools":
        // No tool broker yet; an empty list is the honest answer.
        send(res, 200, { tools: [] });
        return;

      case "/sessions": {
        const body = await readJson(req);
        const workspace = typeof body["workspace"] === "string" ? body["workspace"] : options.workspace;
        const session = await createSession(store, workspace);
        send(res, 201, { id: session.id, workspace: session.workspace });
        return;
      }

      case "/sessions/:id/messages": {
        const id = sessionIdFrom(url.pathname);
        if (!id || !(await store.get(id))) {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (inFlight.has(id)) {
          // One active mutating run per session (SPEC section 22).
          send(res, 409, { error: "run_busy" });
          return;
        }
        const body = await readJson(req);
        const content = typeof body["content"] === "string" ? body["content"] : "";

        const abort = new AbortController();
        inFlight.set(id, abort);
        try {
          await runMessage(store, provider, id, content, abort.signal);
        } finally {
          inFlight.delete(id);
        }
        send(res, 202, { accepted: true });
        return;
      }

      case "/sessions/:id/events": {
        const id = sessionIdFrom(url.pathname);
        if (!id || !(await store.get(id))) {
          send(res, 404, { error: "not_found" });
          return;
        }
        const since = Number(url.searchParams.get("since") ?? 0);
        send(res, 200, { events: await readEvents(store, id, Number.isFinite(since) ? since : 0) });
        return;
      }

      case "/sessions/:id/cancel": {
        const id = sessionIdFrom(url.pathname);
        if (!id || !(await store.get(id))) {
          send(res, 404, { error: "not_found" });
          return;
        }
        inFlight.get(id)?.abort();
        send(res, 200, { cancelled: true });
        return;
      }

      default:
        send(res, 501, { error: "not_implemented", route: route.path });
        return;
    }
  }

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
    close: async () => {
      for (const controller of inFlight.values()) controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await store.close();
    },
  };
}
