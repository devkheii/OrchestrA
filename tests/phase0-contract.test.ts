import { describe, expect, it } from "vitest";
import { NotImplemented, idKind, isId, makeId, ROUTES } from "@dem/protocol";
import * as engine from "@dem/engine";
import * as daemon from "@dem/daemon";

/**
 * The contract gate (plan section 3).
 *
 * In Phase 0 this held the opposite shape: every module was a stub, and this
 * file asserted the invariant suites were red for the *declared* reason rather
 * than because of a wiring error. A suite failing with ReferenceError proves
 * nothing about the contract; one failing with NotImplemented proves the
 * wiring is real and only the body is missing.
 *
 * As Phase 1 landed, entries moved from STUBS to IMPLEMENTED — one at a time,
 * each only once its own suite went green. STUBS is now empty for the v0.1
 * surface, which is what "Phase 1 is feature-complete" means concretely.
 */

type Entry = { name: string; call: () => unknown };

/**
 * v0.1 symbols still awaiting a body. Empty.
 *
 * Deliberately kept rather than deleted: the next phase refills it, and an
 * empty list is a statement worth being able to see fail.
 */
const STUBS: Entry[] = [];

/**
 * Implemented, with the suite that proved it.
 *
 *   step 2  — authenticated daemon           SEC-001, SEC-002
 *   step 3  — session/event persistence      RUN-004
 *   step 7  — path guard and egress          SEC-003, SEC-004, SEC-006
 *   step 8  — permission broker              SEC-008
 *   step 9  — sanitized env, shell exec      SEC-005
 *   step 10 — secret redaction               SEC-015
 *   step 11 — audit, provenance, replay      SEC-014, RUN-006
 *   step 12 — cancellation, budgets          RUN-001, RUN-002
 *   step 13 — patch conflict detection       RUN-003
 *   step 14 — compaction                     RUN-005
 *   config/context                           SEC-013, SEC-016
 *
 * The probes below use valid but inert arguments: they check wiring, not
 * behaviour. Behaviour belongs to the named suites.
 */
const IMPLEMENTED: Entry[] = [
  { name: "isAllowedHost", call: () => daemon.isAllowedHost("127.0.0.1:1", 1) },
  { name: "isAllowedOrigin", call: () => daemon.isAllowedOrigin("http://a", "http://a") },
  { name: "tokenFilePath", call: () => daemon.tokenFilePath("/tmp") },
  { name: "startDaemon", call: () => typeof daemon.startDaemon },
  { name: "openSessionStore", call: () => engine.openSessionStore(":memory:") },
  { name: "resolveWorkspacePath", call: () => engine.resolveWorkspacePath(process.cwd(), ".") },
  { name: "isProtectedPath", call: () => engine.isProtectedPath("src/a.ts") },
  { name: "assertEgressApproved", call: () => engine.assertEgressApproved({ provider: "p", blocks: [] }, []) },
  { name: "selectableModes", call: () => engine.selectableModes("UNAVAILABLE") },
  { name: "segmentCommand", call: () => engine.segmentCommand("a") },
  {
    name: "decide",
    call: () =>
      engine.decide({
        action: "read",
        mode: "ASK",
        taint: "CLEAN",
        sandbox: "UNAVAILABLE",
        subject: "x",
      }),
  },
  { name: "sanitizeChildEnv", call: () => engine.sanitizeChildEnv({}) },
  { name: "redact", call: () => engine.redact("t", []) },
  { name: "execCommand", call: () => typeof engine.execCommand },
  { name: "killProcessTree", call: () => typeof engine.killProcessTree },
  { name: "mergeSettings", call: () => engine.mergeSettings([]) },
  { name: "composeSecurity", call: () => engine.composeSecurity([]) },
  { name: "assemblePrompt", call: () => engine.assemblePrompt([]) },
  { name: "taintOf", call: () => engine.taintOf([]) },
  { name: "stripReasoningChannel", call: () => engine.stripReasoningChannel({}) },
  { name: "openAuditLog", call: () => typeof engine.openAuditLog },
  { name: "replayDryRun", call: () => typeof engine.replayDryRun },
  { name: "writeCheckpoint", call: () => typeof engine.writeCheckpoint },
  { name: "buildWorkingContext", call: () => typeof engine.buildWorkingContext },
  { name: "applyPatch", call: () => engine.applyPatch(process.cwd(), []) },
  { name: "hashFile", call: () => engine.hashFile("does-not-exist") },
  { name: "cancelRun", call: () => typeof engine.cancelRun },
  {
    name: "assertWithinBudget",
    call: () =>
      engine.assertWithinBudget(
        {},
        {
          inputTokens: 0,
          outputTokens: 0,
          wallTimeMs: 0,
          remoteCost: 0,
          rounds: 0,
          counterexampleExecutions: 0,
        },
        {},
      ),
  },
];

/** Test IDs declared in docs/SPEC.md section 31. */
const KNOWN_CONTRACTS = /^(SEC|DEC|RUN|ORCH)-\d{3}$|^phase-\d$/;

describe("Contract gate: stubs fail for a declared reason", () => {
  it("has no v0.1 stub left awaiting a body", () => {
    expect(STUBS.map((s) => s.name)).toEqual([]);
  });

  it.runIf(STUBS.length > 0).each(STUBS)(
    "$name throws NotImplemented, not a wiring error",
    ({ call }) => {
      expect(call).toThrow(NotImplemented);
    },
  );

  it.runIf(STUBS.length > 0).each(STUBS)("$name names the test ID it owes work to", ({ call }) => {
    try {
      call();
      expect.unreachable("stub returned instead of throwing");
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplemented);
      const contracts = (err as NotImplemented).contract.split(",").map((c) => c.trim());
      for (const c of contracts) {
        expect(c, `"${c}" is not a known test ID`).toMatch(KNOWN_CONTRACTS);
      }
    }
  });
});

describe("Contract gate: implemented modules have left the stub list", () => {
  it.each(IMPLEMENTED)("$name no longer throws NotImplemented", ({ call }) => {
    expect(call).not.toThrow(NotImplemented);
  });

  it("never lists the same symbol as both stubbed and implemented", () => {
    const stubbed = new Set(STUBS.map((s) => s.name));
    for (const { name } of IMPLEMENTED) {
      expect(stubbed, `${name} is in both lists`).not.toContain(name);
    }
  });
});

describe("Protocol primitives are real, not stubbed", () => {
  it("round-trips namespaced ids", () => {
    const id = makeId("session", () => "abc");
    expect(id).toBe("ses_abc");
    expect(idKind(id)).toBe("session");
    expect(isId(id, "session")).toBe(true);
    expect(isId(id, "decision")).toBe(false);
  });

  it("rejects an unprefixed or unknown id rather than guessing", () => {
    expect(idKind("abc")).toBeNull();
    expect(idKind("zzz_abc")).toBeNull();
  });

  it("exposes a route table with a single unauthenticated probe", () => {
    const open = ROUTES.filter((r) => !r.authenticated);
    expect(open).toHaveLength(1);
    expect(open[0]?.path).toBe("/healthz");
  });
});
