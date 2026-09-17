import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAgent } from "@dem/adapters";
import { delegate } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * Codex CLI as an external agent.
 *
 * Run against a stand-in emitting the same JSONL shapes. A real run spends the
 * user's account quota and takes tens of seconds, so a suite that called it
 * would compete with the person running it.
 */

const FAKE_CODEX = fileURLToPath(new URL("../helpers/fake-codex.mjs", import.meta.url));

function agent(extra: Record<string, unknown> = {}) {
  return new CodexAgent({
    command: process.execPath,
    commandArgs: [FAKE_CODEX],
    env: { ...process.env },
    ...extra,
  });
}

/** The argv the adapter chose, as the stand-in recorded it. */
function argvFrom(log: string): string[] {
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let frame: { type?: string; argv?: string[] };
    try {
      frame = JSON.parse(line) as { type?: string; argv?: string[] };
    } catch {
      continue;
    }
    if (frame.type === "session_configured") return frame.argv ?? [];
  }
  return [];
}

describe("Codex agent: egress and isolation", () => {
  it("is never local, however local the binary is", () => {
    expect(new CodexAgent().isLocal()).toBe(false);
  });

  it("does not inherit the user's MCP servers", async () => {
    // The probe that prompted this found a browser controller and AWS
    // documentation servers in a real config. Loading them into a delegated
    // run hands the agent reach far outside the copy it was isolated in,
    // which is the one thing the isolation exists to prevent.
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), { workspace: dir, task: "do it", approved: false });
      const argv = argvFrom(result.agentLog);

      expect(argv).toContain("mcp_servers={}");
    });
  });

  it("pins the sandbox and approval policy rather than reading them from config", async () => {
    // A delegated run should not change behaviour because someone edited a
    // personal config file.
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), { workspace: dir, task: "do it", approved: false });
      const argv = argvFrom(result.agentLog);

      expect(argv).toContain("--sandbox");
      expect(argv).toContain("workspace-write");
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).toContain('approval_policy="never"');
    });
  });

  it("lets a caller opt back into the user config, knowingly", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(agent({ inheritUserConfig: true }), {
        workspace: dir,
        task: "do it",
        approved: false,
      });
      expect(argvFrom(result.agentLog)).not.toContain("mcp_servers={}");
    });
  });

  it("points the agent at the copy, not the workspace", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), { workspace: dir, task: "do it", approved: false });
      const argv = argvFrom(result.agentLog);
      const workdir = argv[argv.indexOf("-C") + 1];

      expect(workdir).toBeTruthy();
      expect(workdir).not.toBe(dir);
    });
  });

  it("skips the git repo check, since the copy excludes .git", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), { workspace: dir, task: "do it", approved: false });
      expect(argvFrom(result.agentLog)).toContain("--skip-git-repo-check");
    });
  });
});

describe("Codex agent: producing work", () => {
  it("proposes what it wrote, and applies it on approval", async () => {
    await withTempDir(async (dir) => {
      const proposed = await delegate(agent(), {
        workspace: dir,
        task: "create a file",
        approved: false,
      });
      expect(proposed.changes.map((c) => c.path)).toEqual(["CODEX.md"]);

      const applied = await delegate(agent(), {
        workspace: dir,
        task: "create a file",
        approved: true,
      });
      expect(applied.applied).toBe(true);
      expect(await readFile(join(dir, "CODEX.md"), "utf8")).toBe("written by codex\n");
    });
  });

  it("reports no changes as no changes, not as failure", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_NO_CHANGES",
        approved: true,
      });
      expect(result.ok).toBe(true);
      expect(result.changes).toEqual([]);
    });
  });
});

describe("Codex agent: failure is not silent success", () => {
  it("fails a turn that failed, though the process exited zero (0.154 shape)", async () => {
    // Observed with the real CLI: a rejected model produces an error event, a
    // failed turn, and exit 0. Trusting the exit code would turn a run that
    // did nothing into a success with an empty diff — and an empty diff is
    // indistinguishable from "nothing needed changing".
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_TURN_FAILED",
        approved: true,
      });

      expect(result.ok).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.agentLog).toContain("not supported");
    });
  });

  it("still reads the pre-0.40 wrapped error shape", async () => {
    // The vocabulary changed between versions. Supporting both means a user on
    // either one gets a real failure rather than silent success.
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_LEGACY_ERROR",
        approved: true,
      });
      expect(result.ok).toBe(false);
      expect(result.agentLog).toContain("newer version of Codex");
    });
  });

  it("does not fail a run over an item-level warning", async () => {
    // "Model metadata not found, defaulting to fallback" arrives as an item
    // with type `error` on runs that then succeed. Reading every error-shaped
    // item as fatal would fail working runs.
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_ITEM_WARNING",
        approved: true,
      });

      expect(result.ok).toBe(true);
      expect(result.applied).toBe(true);
      expect(await readFile(join(dir, "CODEX.md"), "utf8")).toBe("written by codex\n");
    });
  });

  it("requires a completed turn rather than merely an absence of errors", async () => {
    // Positive evidence. "No error was seen" would call a run successful
    // whenever a failure arrived in a shape not yet known — which is exactly
    // how the previous version of this adapter broke.
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_TURN_FAILED",
        approved: false,
      });
      expect(result.ok).toBe(false);
    });
  });

  it("reports a crashed process as failure", async () => {
    await withTempDir(async (dir) => {
      const result = await delegate(agent(), {
        workspace: dir,
        task: "SCENARIO_CRASH",
        approved: true,
      });
      expect(result.ok).toBe(false);
    });
  });

  it("reports a missing binary rather than throwing", async () => {
    await withTempDir(async (dir) => {
      const missing = new CodexAgent({ command: "definitely-not-codex-xyz" });
      const result = await delegate(missing, { workspace: dir, task: "x", approved: false });
      expect(result.ok).toBe(false);
      expect(result.agentLog).toContain("could not start");
    });
  });
});
