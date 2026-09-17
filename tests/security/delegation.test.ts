import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { delegate, type ExternalAgent, type AgentRun } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-018 — invariant 34.
 *
 * Delegation to an external agent is the one place every other invariant stops
 * applying: the agent brings its own loop, its own tools and its own
 * permission model. Refusing it outright would give up something genuinely
 * useful, so the boundary is drawn instead (SPEC §4.2).
 *
 * What the boundary has to survive is the tempting shortcut — letting the
 * agent work in the real tree because it is simpler and the diff is right
 * there. That single convenience would suspend the path guard, the conflict
 * detection and the permission broker at once, for as long as the agent runs.
 */

/** An agent that edits whatever directory it is handed. */
function editingAgent(edits: Record<string, string>): ExternalAgent {
  return {
    id: "test-agent",
    isLocal: () => false,
    async run(run: AgentRun) {
      for (const [path, content] of Object.entries(edits)) {
        await writeFile(join(run.workdir, path), content, "utf8");
      }
      return { ok: true, log: "agent log: edited files" };
    },
  };
}

describe("SEC-018: the agent never touches the live workspace", () => {
  it("runs in a copy, leaving the original untouched until re-applied", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "app.ts"), "original\n");

      const seen: string[] = [];
      const agent: ExternalAgent = {
        id: "observer",
        isLocal: () => false,
        async run(run) {
          seen.push(run.workdir);
          // Whatever it does here happens somewhere else.
          await writeFile(join(run.workdir, "app.ts"), "agent edit\n");
          return { ok: true, log: "" };
        },
      };

      const result = await delegate(agent, {
        workspace: dir,
        task: "edit app.ts",
        approved: false,
      });

      expect(seen[0]).not.toBe(dir);
      expect(result.changes.map((c) => c.path)).toEqual(["app.ts"]);
      // Not applied: a change is a proposal until the harness makes it.
      expect(await readFile(join(dir, "app.ts"), "utf8")).toBe("original\n");
    });
  });

  it("re-applies through the harness patch path once approved", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "app.ts"), "original\n");

      const result = await delegate(editingAgent({ "app.ts": "agent edit\n" }), {
        workspace: dir,
        task: "edit app.ts",
        approved: true,
      });

      expect(result.applied).toBe(true);
      expect(await readFile(join(dir, "app.ts"), "utf8")).toBe("agent edit\n");
    });
  });

  it("refuses to apply when the live file moved while the agent worked", async () => {
    // The agent read one thing and the user changed another. Applying anyway
    // would silently discard whichever edit lost the race (invariant 26).
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "app.ts"), "original\n");

      const racingAgent: ExternalAgent = {
        id: "racer",
        isLocal: () => false,
        async run(run) {
          await writeFile(join(run.workdir, "app.ts"), "agent edit\n");
          // Someone edits the real file meanwhile.
          await writeFile(join(dir, "app.ts"), "user edit\n");
          return { ok: true, log: "" };
        },
      };

      const result = await delegate(racingAgent, {
        workspace: dir,
        task: "edit app.ts",
        approved: true,
      });

      expect(result.applied).toBe(false);
      expect(result.conflicts).toEqual(["app.ts"]);
      expect(await readFile(join(dir, "app.ts"), "utf8")).toBe("user edit\n");
    });
  });

  it("carries new files out of the copy as well as edits", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(editingAgent({ "added.ts": "new file\n" }), {
        workspace: dir,
        task: "add a file",
        approved: true,
      });

      expect(result.changes.map((c) => c.kind)).toEqual(["create"]);
      expect(await readFile(join(dir, "added.ts"), "utf8")).toBe("new file\n");
    });
  });

  it("does not copy a directory the workspace ignores", async () => {
    // Copying node_modules would make delegation unusable on any real project,
    // and a .git copy would let an agent rewrite history in the clone.
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", "big.js"), "x".repeat(1000));
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(dir, "src.ts"), "code\n");

      const seenFiles: string[] = [];
      const agent: ExternalAgent = {
        id: "lister",
        isLocal: () => false,
        async run(run) {
          const { readdir } = await import("node:fs/promises");
          seenFiles.push(...(await readdir(run.workdir)));
          return { ok: true, log: "" };
        },
      };

      await delegate(agent, { workspace: dir, task: "look", approved: false });

      expect(seenFiles).toContain("src.ts");
      expect(seenFiles).not.toContain("node_modules");
      expect(seenFiles).not.toContain(".git");
    });
  });
});

describe("SEC-018: the record says guarantees were suspended", () => {
  it("imports the agent's log as an opaque artifact, not as our events", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(editingAgent({ "a.ts": "x\n" }), {
        workspace: dir,
        task: "do something",
        approved: false,
      });

      expect(result.agentLog).toContain("agent log");
      // Labelled as foreign. Presenting it as our trail would imply the tool
      // events inside it passed our broker, and none of them did.
      expect(result.guaranteesSuspended).toBe(true);
      expect(result.agentId).toBe("test-agent");
    });
  });

  it("reports a failing agent rather than treating an empty diff as success", async () => {
    await withTempDir(async (dir) => {
      const failing: ExternalAgent = {
        id: "failer",
        isLocal: () => false,
        async run() {
          return { ok: false, log: "agent crashed" };
        },
      };

      const result = await delegate(failing, {
        workspace: dir,
        task: "try",
        approved: true,
      });

      expect(result.ok).toBe(false);
      expect(result.applied).toBe(false);
    });
  });
});
