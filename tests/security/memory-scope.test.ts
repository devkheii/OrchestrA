import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { openMemoryStore } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-017 — invariant 33.
 *
 * Memory is the one store deliberately shared across sessions, which makes it
 * the one place where a leak is silent and durable. If a note taken while
 * working on a client project surfaces while working on another, nothing
 * errors and nobody is told; it simply appears in a prompt somewhere it should
 * never have been.
 */

const WORKSPACE_A = "/projects/alpha";
const WORKSPACE_B = "/projects/beta";

describe("SEC-017: workspace memory does not cross workspaces", () => {
  it("returns a workspace's own notes and nobody else's", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({
          scope: "workspace",
          workspace: WORKSPACE_A,
          type: "note",
          content: "alpha uses the legacy billing schema",
        });
        await store.write({
          scope: "workspace",
          workspace: WORKSPACE_B,
          type: "note",
          content: "beta uses the legacy billing schema",
        });

        const fromA = await store.search("billing", { scope: "workspace", workspace: WORKSPACE_A });
        expect(fromA).toHaveLength(1);
        expect(fromA[0]?.content).toContain("alpha");
      } finally {
        await store.close();
      }
    });
  });

  it("does not return workspace memory to a search with no workspace named", async () => {
    // The dangerous default: a caller that forgets the scope should get
    // nothing, not everything.
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({
          scope: "workspace",
          workspace: WORKSPACE_A,
          type: "note",
          content: "alpha secret detail",
        });
        const results = await store.search("alpha", { scope: "workspace" });
        expect(results).toHaveLength(0);
      } finally {
        await store.close();
      }
    });
  });

  it("refuses to write workspace memory without a workspace", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await expect(
          store.write({ scope: "workspace", type: "note", content: "unscoped" }),
        ).rejects.toThrow(/workspace/i);
      } finally {
        await store.close();
      }
    });
  });
});

describe("SEC-017: session and agent memory stay within their owner", () => {
  it("keeps session memory out of another session", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({
          scope: "session",
          session: "ses_one",
          type: "note",
          content: "temporary working assumption",
        });
        const other = await store.search("assumption", { scope: "session", session: "ses_two" });
        expect(other).toHaveLength(0);

        const own = await store.search("assumption", { scope: "session", session: "ses_one" });
        expect(own).toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });

  it("keeps agent memory out of another agent", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({
          scope: "agent",
          agent: "reviewer",
          type: "rule",
          content: "always run the linter",
        });
        expect(await store.search("linter", { scope: "agent", agent: "planner" })).toHaveLength(0);
        expect(await store.search("linter", { scope: "agent", agent: "reviewer" })).toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });
});

describe("SEC-017: global memory is shared on purpose", () => {
  it("is visible from any workspace, because that is what global means", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({
          scope: "global",
          type: "preference",
          content: "prefer tabs over spaces",
        });

        const fromA = await store.search("tabs", { scope: "global", workspace: WORKSPACE_A });
        const fromB = await store.search("tabs", { scope: "global", workspace: WORKSPACE_B });
        expect(fromA).toHaveLength(1);
        expect(fromB).toHaveLength(1);
      } finally {
        await store.close();
      }
    });
  });

  it("does not sweep global memory into a workspace-scoped search", async () => {
    // Global is opt-in per query. Folding it in silently would make every
    // workspace search return more than it asked for.
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        await store.write({ scope: "global", type: "preference", content: "prefer tabs" });
        const results = await store.search("tabs", { scope: "workspace", workspace: WORKSPACE_A });
        expect(results).toHaveLength(0);
      } finally {
        await store.close();
      }
    });
  });
});

describe("SEC-017: records carry provenance and survive a restart", () => {
  it("keeps the decision a memory came from", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "app.db");
      const first = await openMemoryStore(dbPath);
      await first.write({
        scope: "workspace",
        workspace: WORKSPACE_A,
        type: "note",
        content: "the retry limit is three",
        sourceDecision: "dec_abc",
      });
      await first.close();

      const second = await openMemoryStore(dbPath);
      try {
        const results = await second.search("retry", {
          scope: "workspace",
          workspace: WORKSPACE_A,
        });
        expect(results[0]?.sourceDecision).toBe("dec_abc");
        expect(results[0]?.id).toMatch(/^mem_/);
      } finally {
        await second.close();
      }
    });
  });

  it("deletes only the record asked for", async () => {
    await withTempDir(async (dir) => {
      const store = await openMemoryStore(join(dir, "app.db"));
      try {
        const keep = await store.write({
          scope: "workspace",
          workspace: WORKSPACE_A,
          type: "note",
          content: "keep this one",
        });
        const drop = await store.write({
          scope: "workspace",
          workspace: WORKSPACE_A,
          type: "note",
          content: "drop this one",
        });

        await store.delete(drop.id);

        const remaining = await store.search("this", {
          scope: "workspace",
          workspace: WORKSPACE_A,
        });
        expect(remaining.map((r) => r.id)).toEqual([keep.id]);
      } finally {
        await store.close();
      }
    });
  });
});
