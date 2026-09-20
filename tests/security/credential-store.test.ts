import { describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSecretBroker,
  credentialStorePath,
  listCredentials,
  readCredential,
  removeCredential,
  writeCredential,
} from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * SEC-025 — credentials a user can actually set (invariant 6).
 *
 * Invariant 6 kept secrets out of config, and for a while the only way left to
 * supply one was an environment variable. That is correct and unusable: a
 * session variable is invisible, does not survive a new terminal, and pushes
 * every user toward pasting the key into a file that gets committed — which is
 * the exact outcome the invariant exists to prevent. A rule that makes the
 * safe path impractical does not produce safety, it produces workarounds.
 *
 * So `secret://` resolves from a store the CLI can write. The earlier
 * objection was to a keychain that silently degrades into a file; a store that
 * says plainly that it is a file, in the home directory, restricted to its
 * owner, is not that.
 */

describe("Where a stored credential lives", () => {
  it("is outside any workspace, so a repository cannot capture it", async () => {
    // The whole point of refusing literals in .dem/config.json. Putting the
    // store in the workspace would reintroduce it under a different name.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        const path = credentialStorePath(home);
        expect(path.startsWith(home)).toBe(true);
        expect(path.startsWith(workspace)).toBe(false);
      });
    });
  });

  it("is readable only by its owner, where the platform can say so", async () => {
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-test-value-1234", home);

      const info = await stat(credentialStorePath(home));
      if (process.platform !== "win32") {
        // 0600. Group and other get nothing.
        expect(info.mode & 0o077).toBe(0);
      } else {
        // Windows permissions are ACLs, not mode bits, and node reports a mode
        // that means little here. The file existing in the user profile is
        // what is asserted; the CLI states the protection rather than implying
        // a guarantee the platform did not give.
        expect(info.isFile()).toBe(true);
      }
    });
  });
});

describe("Storing and retrieving", () => {
  it("round-trips a credential", async () => {
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-test-value-1234", home);
      expect(await readCredential("openai", home)).toBe("sk-test-value-1234");
    });
  });

  it("holds several credentials at once, which is the ordinary case", async () => {
    // A council draws on models from different providers, so more than one key
    // is not an edge case — it is the shape of the feature.
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-aaa-1111", home);
      await writeCredential("qwen-27b", "sk-bbb-2222", home);
      await writeCredential("qwen-flash", "sk-ccc-3333", home);

      expect(await readCredential("qwen-27b", home)).toBe("sk-bbb-2222");
      expect((await listCredentials(home)).map((c) => c.name).sort()).toEqual([
        "openai",
        "qwen-27b",
        "qwen-flash",
      ]);
    });
  });

  it("replaces a credential rather than accumulating duplicates", async () => {
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-old-0000", home);
      await writeCredential("openai", "sk-new-9999", home);

      expect(await readCredential("openai", home)).toBe("sk-new-9999");
      expect(await listCredentials(home)).toHaveLength(1);
    });
  });

  it("removes one without disturbing the others", async () => {
    await withTempDir(async (home) => {
      await writeCredential("a", "sk-aaa-1111", home);
      await writeCredential("b", "sk-bbb-2222", home);

      expect(await removeCredential("a", home)).toBe(true);
      expect(await readCredential("a", home)).toBeUndefined();
      expect(await readCredential("b", home)).toBe("sk-bbb-2222");
    });
  });

  it("reports a missing credential as missing rather than guessing", async () => {
    await withTempDir(async (home) => {
      expect(await readCredential("never-set", home)).toBeUndefined();
      expect(await removeCredential("never-set", home)).toBe(false);
    });
  });
});

describe("Listing never reveals a value", () => {
  it("returns names and nothing that could reconstruct a key", async () => {
    // `dem auth list` is the command a user runs while someone is looking at
    // their screen.
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-secret-value-9876", home);
      const listed = await listCredentials(home);

      expect(JSON.stringify(listed)).not.toContain("sk-secret-value-9876");
      expect(JSON.stringify(listed)).not.toContain("9876");
      expect(listed[0]!.name).toBe("openai");
    });
  });
});

describe("The broker resolves secret:// from the store", () => {
  it("hands the value to an adapter and remembers it for redaction", async () => {
    await withTempDir(async (home) => {
      await writeCredential("qwen-27b", "sk-value-to-redact-4321", home);
      const broker = createSecretBroker({}, home);

      expect(await broker.resolve("secret://qwen-27b")).toBe("sk-value-to-redact-4321");
      // Everything handed out has to be scrubbable, or it surfaces in a log.
      expect(broker.knownValues()).toContain("sk-value-to-redact-4321");
    });
  });

  it("says which name is missing rather than failing vaguely", async () => {
    await withTempDir(async (home) => {
      const broker = createSecretBroker({}, home);
      await expect(broker.resolve("secret://absent")).rejects.toThrow(/absent/);
    });
  });

  it("still resolves env://, because CI has no interactive prompt", async () => {
    await withTempDir(async (home) => {
      const broker = createSecretBroker({ CI_KEY: "sk-from-env-5555" }, home);
      expect(await broker.resolve("env://CI_KEY")).toBe("sk-from-env-5555");
    });
  });

  it("does not quietly answer secret:// from the environment", async () => {
    // The original objection to implementing this at all: a store that
    // silently falls back is worse than none, because the user believes their
    // key is somewhere it is not. The two schemes name two different places
    // and neither stands in for the other.
    await withTempDir(async (home) => {
      const broker = createSecretBroker({ openai: "sk-env-1111", OPENAI: "sk-env-2222" }, home);
      await expect(broker.resolve("secret://openai")).rejects.toThrow();
    });
  });
});

describe("A damaged store fails loudly", () => {
  it("refuses a store it cannot parse rather than acting as if it were empty", async () => {
    // Reporting "no credentials" for a file full of them sends the user to set
    // keys they already set, and the second attempt overwrites the first.
    await withTempDir(async (home) => {
      await mkdir(join(home, ".dem"), { recursive: true });
      await writeFile(credentialStorePath(home), "{not json");

      await expect(listCredentials(home)).rejects.toThrow(/parse|read/i);
    });
  });

  it("treats an absent store as empty, since that is what it means", async () => {
    await withTempDir(async (home) => {
      expect(await listCredentials(home)).toEqual([]);
    });
  });

  it("reports a store it cannot read, rather than skipping it", async () => {
    if (process.platform === "win32") return; // mode bits do not gate reads here
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-test-1234", home);
      await chmod(credentialStorePath(home), 0o000);
      try {
        await expect(listCredentials(home)).rejects.toThrow();
      } finally {
        await chmod(credentialStorePath(home), 0o600);
      }
    });
  });
});

describe("What gets written to disk", () => {
  it("writes no credential into the workspace config path", async () => {
    await withTempDir(async (home) => {
      await writeCredential("openai", "sk-secret-value-7777", home);
      const onDisk = await readFile(credentialStorePath(home), "utf8");

      // It is in the store, and the store is the only place.
      expect(onDisk).toContain("sk-secret-value-7777");
      expect(credentialStorePath(home)).toContain(".dem");
      expect(credentialStorePath(home)).not.toContain("config.json");
    });
  });
});
