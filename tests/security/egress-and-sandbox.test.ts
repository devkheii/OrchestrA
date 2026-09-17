import { describe, expect, it } from "vitest";
import { PolicyViolation, SANDBOX_GATED_MODES } from "@dem/protocol";
import type { ContextBlock, SandboxHealth } from "@dem/protocol";
import { assertEgressApproved, selectableModes } from "@dem/engine";

/**
 * SEC-006 — invariants 1 and 2.
 *
 * Reading a file and sending its contents to a remote provider are separate
 * permissions. Conflating them is how a local-first tool quietly stops being
 * local-first: the agent already had read access, so the upload looks allowed.
 */

const fileBlock: ContextBlock = {
  id: "cb_1",
  trust: "workspace",
  origin: "src/auth.ts",
  content: "const apiSecret = loadSecret();",
};

describe("SEC-006: file read does not imply remote egress", () => {
  it("refuses to send workspace content with no approval", () => {
    expect(() =>
      assertEgressApproved({ provider: "remote-llm", blocks: [fileBlock] }, []),
    ).toThrow(PolicyViolation);
  });

  it("refuses when the approval covers a different provider", () => {
    expect(() =>
      assertEgressApproved({ provider: "remote-llm", blocks: [fileBlock] }, [
        { approved: true, blocks: [fileBlock], reason: "approved for other-provider" },
      ]),
    ).toThrow(PolicyViolation);
  });

  it("refuses when the approval covers only some of the blocks", () => {
    const second: ContextBlock = { ...fileBlock, id: "cb_2", origin: "src/db.ts" };
    expect(() =>
      assertEgressApproved({ provider: "remote-llm", blocks: [fileBlock, second] }, [
        { approved: true, blocks: [fileBlock], reason: "user approved cb_1 only" },
      ]),
    ).toThrow(PolicyViolation);
  });

  it("permits transmission once an explicit approval covers the blocks", () => {
    expect(() =>
      assertEgressApproved({ provider: "remote-llm", blocks: [fileBlock] }, [
        { approved: true, blocks: [fileBlock], reason: "user approved" },
      ]),
    ).not.toThrow();
  });
});

/**
 * SEC-008 — invariant 21, and the v0.1 shape of SPEC section 19.1.
 *
 * v0.1 ships no sandbox adapter, so the probe reports UNAVAILABLE and AUTO
 * must be unreachable. The failure this guards against is the tempting one:
 * sandbox missing, so run unsandboxed and keep the convenient mode.
 */
describe("SEC-008: sandbox health gates AUTO", () => {
  it("offers no sandbox-gated mode when the sandbox is unavailable", () => {
    const modes = selectableModes("UNAVAILABLE");
    for (const gated of SANDBOX_GATED_MODES) {
      expect(modes, `${gated} must not be selectable without a sandbox`).not.toContain(gated);
    }
    expect(modes).toContain("ASK");
    expect(modes).toContain("READ_ONLY");
  });

  it("does not offer AUTO on a degraded sandbox either", () => {
    expect(selectableModes("DEGRADED")).not.toContain("AUTO");
  });

  it("offers AUTO only when the sandbox is healthy", () => {
    expect(selectableModes("HEALTHY")).toContain("AUTO");
  });

  it("never returns an empty set, so the harness stays usable", () => {
    const healths: SandboxHealth[] = ["HEALTHY", "DEGRADED", "UNAVAILABLE"];
    for (const h of healths) {
      expect(selectableModes(h).length).toBeGreaterThan(0);
    }
  });
});
