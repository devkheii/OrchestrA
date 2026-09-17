import { describe, expect, it } from "vitest";
import { PolicyViolation } from "@dem/protocol";
import { resolveProvider } from "@dem/daemon";

/**
 * SEC-006 (continued) — invariants 1 and 2.
 *
 * "Local-first" has to be enforced somewhere concrete or it stays a slogan.
 * The concrete place is here: an endpoint that is not loopback is refused
 * unless the user said so in as many words.
 *
 * The failure this prevents is quiet. Someone exports a base URL once, and
 * from then on every file the agent reads goes to a third party, with nothing
 * in the interface saying so.
 */

describe("SEC-006: a non-loopback provider requires explicit consent", () => {
  it("defaults to a local fake when nothing is configured", () => {
    const selection = resolveProvider({});
    expect(selection.local).toBe(true);
    expect(selection.label).toContain("fake");
  });

  it("accepts a loopback endpoint without ceremony", () => {
    const selection = resolveProvider({
      DEM_BASE_URL: "http://127.0.0.1:8080",
      DEM_MODEL: "qwen",
    });
    expect(selection.local).toBe(true);
  });

  it("refuses a public endpoint that was not explicitly allowed", () => {
    expect(() =>
      resolveProvider({ DEM_BASE_URL: "https://api.example.com", DEM_MODEL: "gpt" }),
    ).toThrow(PolicyViolation);
  });

  it("refuses a LAN address too, since another machine is another party", () => {
    // The common mistake: treating a private IP range as "local". A machine on
    // the same network is still someone else's, and may be someone else's to read.
    expect(() => resolveProvider({ DEM_BASE_URL: "http://192.168.1.50:8080" })).toThrow(
      PolicyViolation,
    );
  });

  it("explains what accepting would mean, not just that it refused", () => {
    try {
      resolveProvider({ DEM_BASE_URL: "https://api.example.com" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("leave the machine");
      expect((err as Error).message).toContain("DEM_ALLOW_REMOTE=1");
    }
  });

  it("permits a public endpoint once the user opts in, and says it is remote", () => {
    const selection = resolveProvider({
      DEM_BASE_URL: "https://api.example.com",
      DEM_MODEL: "gpt",
      DEM_ALLOW_REMOTE: "1",
    });
    expect(selection.local).toBe(false);
    expect(selection.label).toContain("REMOTE");
  });

  it("refuses the local Claude CLI binary too, because its data still leaves", () => {
    // The sharpest version of this mistake: the process is on this machine, so
    // a URL-shaped check waves it through while it forwards the whole context
    // to a third party.
    expect(() => resolveProvider({ DEM_PROVIDER: "claude-cli" })).toThrow(PolicyViolation);
  });

  it("permits the Claude CLI once opted in, and labels it REMOTE", () => {
    const selection = resolveProvider({ DEM_PROVIDER: "claude-cli", DEM_ALLOW_REMOTE: "1" });
    expect(selection.local).toBe(false);
    expect(selection.label).toContain("REMOTE");
    expect(selection.provider.id).toContain("claude-cli");
  });

  it("refuses the Anthropic provider without a key, and says what it costs", () => {
    // The two Claude adapters look interchangeable from outside and are not:
    // one draws on a subscription window, this one bills per request.
    try {
      resolveProvider({ DEM_PROVIDER: "anthropic" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("bills per request");
    }
  });

  it("treats the Anthropic API as remote, since it is", () => {
    expect(() =>
      resolveProvider({ DEM_PROVIDER: "anthropic", DEM_API_KEY: "sk-x" }),
    ).toThrow(PolicyViolation);

    const selection = resolveProvider({
      DEM_PROVIDER: "anthropic",
      DEM_API_KEY: "sk-x",
      DEM_ALLOW_REMOTE: "1",
    });
    expect(selection.local).toBe(false);
    expect(selection.provider.id).toContain("anthropic");
    expect(selection.provider.id).not.toContain("sk-x");
  });

  it("never puts the API key in the label or provider id", () => {
    const selection = resolveProvider({
      DEM_BASE_URL: "http://127.0.0.1:8080",
      DEM_API_KEY: "sk-secret-value",
    });
    expect(selection.label).not.toContain("sk-secret-value");
    expect(selection.provider.id).not.toContain("sk-secret-value");
  });
});
