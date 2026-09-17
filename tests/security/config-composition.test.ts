import { describe, expect, it } from "vitest";
import { CONFIG_PRECEDENCE } from "@dem/protocol";
import type { ScopedConfig } from "@dem/protocol";
import { composeSecurity, mergeSettings } from "@dem/engine";

/**
 * SEC-013 — invariant 29.
 *
 * Ordinary settings follow precedence; security composes monotonically. The
 * distinction matters because a workspace config is checked-in content the
 * user may not have written. It must not be able to grant itself AUTO or
 * re-enable remote egress by simply being more specific.
 */

const user: ScopedConfig = {
  scope: "user",
  security: {
    denyCommands: ["rm -rf", "git push --force"],
    allowPaths: ["/work", "/tmp"],
    maxMode: "ASK",
    remoteEgress: false,
  },
  settings: { theme: "dark", model: "qwen-local" },
};

const workspace: ScopedConfig = {
  scope: "workspace",
  security: {
    // Attempts to widen every dimension.
    denyCommands: [],
    allowPaths: ["/work", "/tmp", "/etc"],
    maxMode: "FULL_ACCESS",
    remoteEgress: true,
  },
  settings: { model: "gemma-local" },
};

describe("SEC-013: security config composes monotonically", () => {
  it("keeps deny rules from every scope (union)", () => {
    const composed = composeSecurity([user, workspace]);
    expect(composed.denyCommands).toContain("rm -rf");
    expect(composed.denyCommands).toContain("git push --force");
  });

  it("does not let a lower scope widen readable paths (intersection)", () => {
    const composed = composeSecurity([user, workspace]);
    expect(composed.allowPaths).not.toContain("/etc");
    expect(composed.allowPaths).toContain("/work");
  });

  it("does not let a lower scope raise the permission ceiling (minimum)", () => {
    const composed = composeSecurity([user, workspace]);
    expect(composed.maxMode).toBe("ASK");
  });

  it("does not let a lower scope re-enable remote egress (logical AND)", () => {
    const composed = composeSecurity([user, workspace]);
    expect(composed.remoteEgress).toBe(false);
  });

  it("allows a lower scope to tighten", () => {
    const stricter: ScopedConfig = {
      scope: "workspace",
      security: { maxMode: "READ_ONLY", denyCommands: ["curl"] },
    };
    const composed = composeSecurity([user, stricter]);
    expect(composed.maxMode).toBe("READ_ONLY");
    expect(composed.denyCommands).toContain("curl");
  });

  it("applies the same rule to the environment channel", () => {
    // Environment outranks workspace for ordinary settings, but that authority
    // does not extend to widening a hard safety rule.
    const env: ScopedConfig = {
      scope: "environment",
      security: { maxMode: "FULL_ACCESS", remoteEgress: true },
    };
    const composed = composeSecurity([user, env]);
    expect(composed.maxMode).toBe("ASK");
    expect(composed.remoteEgress).toBe(false);
  });
});

describe("SEC-013: ordinary settings follow precedence", () => {
  it("orders scopes with CLI highest and environment directly below it", () => {
    expect([...CONFIG_PRECEDENCE]).toEqual([
      "cli",
      "environment",
      "workspace",
      "user",
      "defaults",
    ]);
  });

  it("lets environment override workspace, so CI and containers can inject", () => {
    const env: ScopedConfig = { scope: "environment", settings: { model: "remote-expert" } };
    const merged = mergeSettings([user, workspace, env]);
    expect(merged["model"]).toBe("remote-expert");
  });

  it("lets a higher scope override a lower one and keeps unrelated keys", () => {
    const merged = mergeSettings([user, workspace]);
    expect(merged["model"]).toBe("gemma-local");
    expect(merged["theme"]).toBe("dark");
  });
});
