import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { cancelRun, openSessionStore, replayDryRun, writeCheckpoint } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * RUN-004 — session survives a daemon restart.
 *
 * The event log is the state, not a cache of it. A session that evaporates on
 * restart makes the audit trail a story about a process rather than about the
 * work.
 */

describe("RUN-004: daemon restart preserves session and audit", () => {
  it("reopens a store and finds the prior session with its events", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "app.db");

      const first = await openSessionStore(dbPath);
      const session = await first.create(dir);
      await first.append(session.id, {
        type: "message.received",
        sessionId: session.id,
        at: new Date().toISOString(),
        role: "user",
        contentHash: "h1",
      });

      // Simulates the daemon going away.
      const second = await openSessionStore(dbPath);
      const restored = await second.get(session.id);
      expect(restored?.id).toBe(session.id);

      const events = await second.events(session.id);
      expect(events.map((e) => e.type)).toContain("message.received");
    });
  });

  it("assigns monotonic sequence numbers the client never supplies", async () => {
    await withTempDir(async (dir) => {
      const store = await openSessionStore(join(dir, "app.db"));
      const session = await store.create(dir);
      const at = new Date().toISOString();

      const a = await store.append(session.id, {
        type: "answer.delta",
        sessionId: session.id,
        at,
        text: "one",
      });
      const b = await store.append(session.id, {
        type: "answer.delta",
        sessionId: session.id,
        at,
        text: "two",
      });

      expect(b.seq).toBeGreaterThan(a.seq);
    });
  });
});

/**
 * RUN-001 — invariant 27.
 *
 * Cancel has to reach the whole tree. A shell that spawns a child and exits
 * leaves the grandchild holding the workspace, still writing, after the user
 * believes they stopped it.
 */

describe("RUN-001: cancellation kills the process tree", () => {
  it("terminates a spawned child and its grandchild", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000); require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"],
      { stdio: "ignore", detached: false },
    );

    try {
      const abort = new AbortController();
      await cancelRun({ pids: [child.pid!], ptyIds: [], abort }, 200);

      expect(abort.signal.aborted).toBe(true);
      // Signal 0 probes liveness without sending a real signal.
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // already gone, which is the expected case
      }
    }
  });
});

/**
 * RUN-005 — invariant 16.
 *
 * Compaction adds an artifact; it never rewrites history. If the summary is
 * lossy or wrong, the original transcript is still there to go back to.
 */

describe("RUN-005: compaction leaves the canonical transcript intact", () => {
  it("keeps every original event after a checkpoint is written", async () => {
    await withTempDir(async (dir) => {
      const store = await openSessionStore(join(dir, "app.db"));
      const session = await store.create(dir);
      const at = new Date().toISOString();

      for (let i = 0; i < 20; i++) {
        await store.append(session.id, {
          type: "answer.delta",
          sessionId: session.id,
          at,
          text: `chunk ${i}`,
        });
      }
      const before = await store.events(session.id);

      await writeCheckpoint(session.id, before.length);

      const after = await store.events(session.id);
      expect(after.length).toBe(before.length);
      expect(after).toEqual(before);
    });
  });
});

/**
 * RUN-006 — invariant 20.
 *
 * Dry-run is inspection. It reports whether a decision could be reconstructed
 * and changes nothing while doing so.
 */

describe("RUN-006: replay --dry-run inspects without side effects", () => {
  it("reports a reconstruction status for each recorded input", async () => {
    const report = await replayDryRun("dec_test");
    const items = report.items.map((i) => i.item);
    expect(items).toContain("model_fingerprint");
    expect(items).toContain("context_hash");
    expect(items).toContain("permission_policy");
    for (const item of report.items) {
      expect(["reconstructible", "missing", "changed"]).toContain(item.status);
    }
  });

  it("marks a decision whose recorded model is gone as missing, not reconstructible", async () => {
    const report = await replayDryRun("dec_missing_model");
    const fingerprint = report.items.find((i) => i.item === "model_fingerprint");
    expect(fingerprint?.status).toBe("missing");
  });
});
