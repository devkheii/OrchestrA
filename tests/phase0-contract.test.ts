import { describe, expect, it } from "vitest";
import { NotImplemented, idKind, isId, makeId, ROUTES } from "@dem/protocol";
import * as engine from "@dem/engine";
import * as daemon from "@dem/daemon";

/**
 * Phase 0 exit gate (plan section 3).
 *
 * The invariant suites are red right now, and they should be. This test
 * asserts they are red for the *declared* reason: every stub exists, is
 * exported, and names the test ID it owes work to. A suite failing with
 * ReferenceError proves nothing about the contract; one failing with
 * NotImplemented proves the wiring is real and only the body is missing.
 */

type Stub = { name: string; call: () => unknown };

const STUBS: Stub[] = [
  { name: "mergeSettings", call: () => engine.mergeSettings([]) },
  { name: "composeSecurity", call: () => engine.composeSecurity([]) },
  { name: "assertWithinBudget", call: () => engine.assertWithinBudget({}, {
    inputTokens: 0, outputTokens: 0, wallTimeMs: 0, remoteCost: 0, rounds: 0,
    counterexampleExecutions: 0,
  }, {}) },
  { name: "assemblePrompt", call: () => engine.assemblePrompt([]) },
  { name: "taintOf", call: () => engine.taintOf([]) },
  { name: "stripReasoningChannel", call: () => engine.stripReasoningChannel({}) },
  { name: "openAuditLog", call: () => engine.openAuditLog("/tmp") },
  { name: "replayDryRun", call: () => engine.replayDryRun("dec_x") },
  { name: "cancelRun", call: () => engine.cancelRun({ pids: [], ptyIds: [], abort: new AbortController() }, 1) },
  { name: "writeCheckpoint", call: () => engine.writeCheckpoint("ses_x", 0) },
  { name: "buildWorkingContext", call: () => engine.buildWorkingContext({
    sessionId: "ses_x", throughSeq: 0, goal: "", decisions: [], filesChanged: [],
    completed: [], pending: [], errors: [], constraints: [], evidenceRefs: [],
    memoryRefs: [], createdAt: "",
  }, 1) },
  { name: "applyPatch", call: () => engine.applyPatch("/w", []) },
  { name: "hashFile", call: () => engine.hashFile("/w/a") },
];

/**
 * Implemented, so no longer stubs. STUBS shrinks and this grows as phases
 * land; an entry moves across only when its own suite is green.
 *
 *   Phase 1 step 2 — authenticated daemon      (SEC-001, SEC-002)
 *   Phase 1 step 3 — session/event persistence (RUN-004)
 *   Phase 1 step 7 — path guard and egress       (SEC-003, SEC-004, SEC-006)
 *   Phase 1 step 8 — permission broker           (SEC-008)
 *   Phase 1 step 9 — sanitized env, shell exec   (SEC-005)
 *   Phase 1 step 10 — secret redaction           (SEC-015)
 *
 * The probe below calls each with valid but inert arguments: it checks the
 * wiring, not the behaviour. Behaviour belongs to the named suites.
 */
const IMPLEMENTED: Stub[] = [
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
  { name: "decide", call: () => engine.decide({ action: "read", mode: "ASK", taint: "CLEAN", sandbox: "UNAVAILABLE", subject: "x" }) },
  { name: "sanitizeChildEnv", call: () => engine.sanitizeChildEnv({}) },
  { name: "redact", call: () => engine.redact("t", []) },
  { name: "execCommand", call: () => typeof engine.execCommand },
  { name: "killProcessTree", call: () => typeof engine.killProcessTree },
];

/** Test IDs declared in docs/SPEC.md section 31. */
const KNOWN_CONTRACTS = /^(SEC|DEC|RUN|ORCH)-\d{3}$|^phase-\d$/;

describe("Phase 0: the contract is wired before any module is written", () => {
  it.each(STUBS)("$name throws NotImplemented, not a wiring error", ({ call }) => {
    expect(call).toThrow(NotImplemented);
  });

  it.each(STUBS)("$name names the test ID it owes work to", ({ call }) => {
    try {
      call();
      expect.unreachable("stub returned instead of throwing");
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplemented);
      const contracts = (err as NotImplemented).contract.split(",").map((c) => c.trim());
      expect(contracts.length).toBeGreaterThan(0);
      for (const c of contracts) {
        expect(c, `"${c}" is not a known test ID`).toMatch(KNOWN_CONTRACTS);
      }
    }
  });
});

describe("Phase 1: implemented modules have left the stub list", () => {
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

describe("Phase 0: protocol primitives are real, not stubbed", () => {
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
