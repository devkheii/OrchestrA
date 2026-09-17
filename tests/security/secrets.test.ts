import { describe, expect, it } from "vitest";
import { ENV_ALLOWLIST, redact, sanitizeChildEnv } from "@dem/engine";

/**
 * SEC-005 / SEC-015 — invariants 6 and 7.
 *
 * The child environment is built by allowlist, not by copying process.env and
 * deleting known-bad keys. The deletion approach fails open for every provider
 * variable nobody thought of, which is every provider added after the code was
 * written.
 */

const PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/dev",
  TERM: "xterm",
  LANG: "en_US.UTF-8",
  OPENAI_API_KEY: "sk-live-abc123",
  ANTHROPIC_API_KEY: "sk-ant-xyz789",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_realtoken",
  DATABASE_PASSWORD: "hunter2",
  // A provider that did not exist when the denylist was written.
  ACME_LLM_CREDENTIAL: "acme-secret",
  SOME_FUTURE_PROVIDER_KEY: "future-secret",
} satisfies NodeJS.ProcessEnv;

describe("SEC-005: child shell environment contains no provider secrets", () => {
  it("passes through allowlisted variables", () => {
    const child = sanitizeChildEnv(PARENT_ENV);
    expect(child["PATH"]).toBe("/usr/bin");
    expect(child["HOME"]).toBe("/home/dev");
    expect(child["TERM"]).toBe("xterm");
  });

  it("drops every secret-shaped variable", () => {
    const child = sanitizeChildEnv(PARENT_ENV);
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "DATABASE_PASSWORD",
    ]) {
      expect(child, `${key} must not reach the child`).not.toHaveProperty(key);
    }
  });

  it("drops unknown variables, including providers added later", () => {
    const child = sanitizeChildEnv(PARENT_ENV);
    // This is the assertion that makes it an allowlist rather than a denylist.
    expect(child).not.toHaveProperty("ACME_LLM_CREDENTIAL");
    expect(child).not.toHaveProperty("SOME_FUTURE_PROVIDER_KEY");
    for (const key of Object.keys(child)) {
      expect(ENV_ALLOWLIST, `${key} leaked past the allowlist`).toContain(key);
    }
  });

  it("does not mutate the parent environment", () => {
    const snapshot = { ...PARENT_ENV };
    sanitizeChildEnv(PARENT_ENV);
    expect(PARENT_ENV).toEqual(snapshot);
  });
});

describe("SEC-015: secret values are redacted from output", () => {
  const secrets = ["sk-live-abc123", "ghp_realtoken"];

  it("replaces secret values wherever they appear", () => {
    const out = redact("calling with sk-live-abc123 and ghp_realtoken", secrets);
    expect(out).not.toContain("sk-live-abc123");
    expect(out).not.toContain("ghp_realtoken");
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redact("sk-live-abc123 ... sk-live-abc123", secrets);
    expect(out).not.toContain("sk-live-abc123");
  });

  it("redacts a secret split across a line boundary in tool output", () => {
    const out = redact(`token=sk-live-abc123\nnext line`, secrets);
    expect(out).not.toContain("sk-live-abc123");
    expect(out).toContain("next line");
  });

  it("leaves unrelated text intact", () => {
    expect(redact("nothing sensitive here", secrets)).toBe("nothing sensitive here");
  });

  it("ignores empty secret values rather than redacting everything", () => {
    // A misconfigured broker returning "" must not turn output into a wall of masks.
    expect(redact("plain text", [""])).toBe("plain text");
  });
});
