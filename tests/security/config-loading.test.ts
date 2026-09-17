import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PolicyViolation } from "@dem/protocol";
import { loadScopes, resolveSettings } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-013 (loading) and SEC-023 — invariants 29 and 6.
 *
 * SPEC §33 defines a precedence chain and a monotonic security composition,
 * and both were implemented and tested as pure functions — while nothing ever
 * read a file, so the whole design was unreachable. This is the layer that
 * makes it real, and it is where two things can go quietly wrong: a config
 * that does not apply but looks like it did, and a credential written into a
 * file that is checked in.
 */

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await mkdir(join(dir, ".dem"), { recursive: true });
  await writeFile(join(dir, ".dem", "config.json"), JSON.stringify(config), "utf8");
}

describe("SEC-013: precedence, loaded from disk", () => {
  it("returns defaults when nothing is configured", async () => {
    await withTempDir(async (dir) => {
      const settings = await resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} });
      expect(settings.model).toBeUndefined();
      expect(settings.allowRemote).toBe(false);
    });
  });

  it("lets a workspace config override the user's", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(home, { model: "user-model" });
        await writeConfig(workspace, { model: "workspace-model" });

        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        expect(settings.model).toBe("workspace-model");
      });
    });
  });

  it("lets the environment override a workspace config", async () => {
    // CI and containers frequently have no user config at all, so this is
    // their only injection channel (SPEC §33).
    await withTempDir(async (dir) => {
      await writeConfig(dir, { model: "workspace-model" });
      const settings = await resolveSettings({
        workspace: dir,
        home: dir,
        env: { DEM_MODEL: "env-model" },
        cli: {},
      });
      expect(settings.model).toBe("env-model");
    });
  });

  it("lets an explicit flag override everything", async () => {
    await withTempDir(async (dir) => {
      await writeConfig(dir, { model: "workspace-model" });
      const settings = await resolveSettings({
        workspace: dir,
        home: dir,
        env: { DEM_MODEL: "env-model" },
        cli: { model: "flag-model" },
      });
      expect(settings.model).toBe("flag-model");
    });
  });

  it("keeps keys from lower scopes that a higher one does not mention", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(home, { model: "user-model", baseUrl: "http://127.0.0.1:1" });
        await writeConfig(workspace, { model: "workspace-model" });

        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        expect(settings.model).toBe("workspace-model");
        expect(settings.baseUrl).toBe("http://127.0.0.1:1");
      });
    });
  });
});

describe("SEC-013: a workspace config cannot widen a safety rule", () => {
  it("cannot raise the permission ceiling the user set", async () => {
    // A workspace config is checked-in content the user may not have written
    // and may not have read.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(home, { security: { maxMode: "ASK" } });
        await writeConfig(workspace, { security: { maxMode: "FULL_ACCESS" } });

        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        expect(settings.security.maxMode).toBe("ASK");
      });
    });
  });

  it("cannot re-enable remote egress the user disabled", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(home, { security: { remoteEgress: false } });
        await writeConfig(workspace, { security: { remoteEgress: true } });

        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        expect(settings.security.remoteEgress).toBe(false);
      });
    });
  });

  it("can tighten, which is the direction that is allowed", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(home, { security: { maxMode: "AUTO" } });
        await writeConfig(workspace, { security: { maxMode: "READ_ONLY" } });

        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        expect(settings.security.maxMode).toBe("READ_ONLY");
      });
    });
  });
});

describe("SEC-013: a config that does not apply says so", () => {
  it("refuses malformed JSON rather than silently ignoring the file", async () => {
    // Silent fallback is the dangerous failure: the user believes their
    // settings are in force — including the security ones — and they are not.
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".dem"), { recursive: true });
      await writeFile(join(dir, ".dem", "config.json"), "{ not json", "utf8");

      await expect(
        resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} }),
      ).rejects.toThrow(/config\.json/);
    });
  });

  it("names the file it could not read", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".dem"), { recursive: true });
      await writeFile(join(dir, ".dem", "config.json"), "[]", "utf8");

      try {
        await resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(dir);
      }
    });
  });

  it("treats an absent file as no opinion, not as an error", async () => {
    await withTempDir(async (dir) => {
      const scopes = await loadScopes({ workspace: dir, home: dir, env: {}, cli: {} });
      expect(scopes.some((s) => s.scope === "defaults")).toBe(true);
    });
  });
});

describe("SEC-023: a credential in a config file is refused", () => {
  it("rejects a literal API key, naming the field", async () => {
    // Config files get committed. A key written here is a key in the history
    // of whatever repository this workspace is, and invariant 6 says secrets
    // never enter ordinary config (SPEC §33).
    await withTempDir(async (dir) => {
      await writeConfig(dir, { apiKey: "sk-ant-api03-reallysecretvalue" });

      await expect(
        resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} }),
      ).rejects.toThrow(PolicyViolation);
    });
  });

  it("accepts a reference, which is what the field is for", async () => {
    await withTempDir(async (dir) => {
      await writeConfig(dir, { apiKey: "env://ANTHROPIC_API_KEY" });

      const settings = await resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} });
      expect(settings.apiKey).toBe("env://ANTHROPIC_API_KEY");
    });
  });

  it("explains what to write instead", async () => {
    await withTempDir(async (dir) => {
      await writeConfig(dir, { apiKey: "sk-proj-abcdefghijklmnop" });

      try {
        await resolveSettings({ workspace: dir, home: dir, env: {}, cli: {} });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("env://");
      }
    });
  });

  it("still allows a key through the environment, where it is not committed", async () => {
    await withTempDir(async (dir) => {
      const settings = await resolveSettings({
        workspace: dir,
        home: dir,
        env: { DEM_API_KEY: "sk-ant-api03-fromenv" },
        cli: {},
      });
      expect(settings.apiKey).toBe("sk-ant-api03-fromenv");
    });
  });
});
