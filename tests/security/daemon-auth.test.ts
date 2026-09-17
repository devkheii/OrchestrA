import { describe, expect, it } from "vitest";
import { ROUTES, HEALTHZ_FORBIDDEN_KEYS } from "@dem/protocol";
import { isAllowedHost, isAllowedOrigin, startDaemon } from "@dem/daemon";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-001 / SEC-002 — invariants 4 and 5.
 *
 * `localhost` is not a security boundary. Any process on the machine can
 * reach the port, and a page in the user's browser can attempt it too. The
 * daemon can patch files and run shells, so every route is authenticated.
 */

describe("SEC-001: every daemon endpoint requires authentication", () => {
  it("declares auth on every route except the coarse health probe", () => {
    for (const route of ROUTES) {
      if (route.path === "/healthz") {
        expect(route.authenticated).toBe(false);
        continue;
      }
      expect(
        route.authenticated,
        `${route.method} ${route.path} must require authentication`,
      ).toBe(true);
    }
  });

  it("rejects unauthenticated requests to every route, streams included", async () => {
    await withTempDir(async (dir) => {
      const daemon = await startDaemon({ workspace: dir, stateDir: dir });
      try {
        for (const route of ROUTES) {
          if (route.path === "/healthz") continue;
          const url = daemon.url + route.path.replace(":id", "ses_anything");
          const res = await fetch(url, { method: route.method });
          expect(res.status, `${route.method} ${route.path}`).toBe(401);
        }
      } finally {
        await daemon.close();
      }
    });
  });

  it("accepts the bearer credential minted at startup", async () => {
    await withTempDir(async (dir) => {
      const daemon = await startDaemon({ workspace: dir, stateDir: dir });
      try {
        const res = await fetch(daemon.url + "/models", {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        expect(res.status).toBe(200);
      } finally {
        await daemon.close();
      }
    });
  });

  it("never exposes anything beyond liveness on /healthz", async () => {
    await withTempDir(async (dir) => {
      const daemon = await startDaemon({ workspace: dir, stateDir: dir });
      try {
        const res = await fetch(daemon.url + "/healthz");
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["status"]);
        for (const forbidden of HEALTHZ_FORBIDDEN_KEYS) {
          expect(body).not.toHaveProperty(forbidden);
        }
      } finally {
        await daemon.close();
      }
    });
  });
});

describe("SEC-002: Host and Origin validation, CORS deny-by-default", () => {
  it("rejects a Host header that is not the bound loopback address", () => {
    expect(isAllowedHost("127.0.0.1:7777", 7777)).toBe(true);
    expect(isAllowedHost("localhost:7777", 7777)).toBe(true);
    // DNS rebinding: attacker domain resolved to 127.0.0.1.
    expect(isAllowedHost("evil.example.com:7777", 7777)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", 7777)).toBe(false);
    expect(isAllowedHost(undefined, 7777)).toBe(false);
  });

  it("allows only the daemon's own origin", () => {
    const self = "http://127.0.0.1:7777";
    expect(isAllowedOrigin(self, self)).toBe(true);
    expect(isAllowedOrigin("http://evil.example.com", self)).toBe(false);
    expect(isAllowedOrigin("null", self)).toBe(false);
  });

  it("refuses a cross-origin request even when the token is correct", async () => {
    await withTempDir(async (dir) => {
      const daemon = await startDaemon({ workspace: dir, stateDir: dir });
      try {
        const res = await fetch(daemon.url + "/models", {
          headers: {
            authorization: `Bearer ${daemon.token}`,
            origin: "http://evil.example.com",
          },
        });
        expect(res.status).toBe(403);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        await daemon.close();
      }
    });
  });
});
