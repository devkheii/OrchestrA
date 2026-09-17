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
  { name: "resolveWorkspacePath", call: () => engine.resolveWorkspacePath("/w", "a") },
  { name: "isProtectedPath", call: () => engine.isProtectedPath(".env") },
  { name: "mergeSettings", call: () => engine.mergeSettings([]) },
  { name: "composeSecurity", call: () => engine.composeSecurity([]) },
  { name: "assertWithinBudget", call: () => engine.assertWithinBudget({}, {
    inputTokens: 0, outputTokens: 0, wallTimeMs: 0, remoteCost: 0, rounds: 0,
    counterexampleExecutions: 0,
  }, {}) },
  { name: "assertEgressApproved", call: () => engine.assertEgressApproved({ provider: "p", blocks: [] }, []) },
  { name: "selectableModes", call: () => engine.selectableModes("UNAVAILABLE") },
  { name: "decide", call: () => engine.decide({
    action: "read", mode: "ASK", taint: "CLEAN", sandbox: "UNAVAILABLE", subject: "x",
  }) },
  { name: "segmentCommand", call: () => engine.segmentCommand("a && b") },
  { name: "sanitizeChildEnv", call: () => engine.sanitizeChildEnv({}) },
  { name: "redact", call: () => engine.redact("t", []) },
  { name: "assemblePrompt", call: () => engine.assemblePrompt([]) },
  { name: "taintOf", call: () => engine.taintOf([]) },
  { name: "stripReasoningChannel", call: () => engine.stripReasoningChannel({}) },
  { name: "openAuditLog", call: () => engine.openAuditLog("/tmp") },
  { name: "replayDryRun", call: () => engine.replayDryRun("dec_x") },
  { name: "openSessionStore", call: () => engine.openSessionStore("/tmp/a.db") },
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
 * Implemented, so no longer stubs. This list shrinks as phases land; an entry
 * moves out of STUBS only when its own suite is green.
 *
 *   Phase 1 step 2 — startDaemon, isAllowedHost, isAllowedOrigin, tokenFilePath
 */
const IMPLEMENTED: readonly string[] = [
  "startDaemon",
  "isAllowedHost",
  "isAllowedOrigin",
  "tokenFilePath",
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
  it.each(IMPLEMENTED)("%s is exported and no longer throws NotImplemented", (name) => {
    const fn = (daemon as Record<string, unknown>)[name];
    expect(typeof fn, `${name} is not exported`).toBe("function");
    // Called with arguments that are valid but inert, so this checks wiring
    // rather than behaviour; behaviour belongs to the SEC-00x suites.
    const probe: Record<string, () => unknown> = {
      isAllowedHost: () => daemon.isAllowedHost("127.0.0.1:1", 1),
      isAllowedOrigin: () => daemon.isAllowedOrigin("http://a", "http://a"),
      tokenFilePath: () => daemon.tokenFilePath("/tmp"),
      startDaemon: () => undefined, // starting a server is the suite's job, not this one
    };
    expect(probe[name]).toBeDefined();
    expect(() => probe[name]?.()).not.toThrow(NotImplemented);
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
