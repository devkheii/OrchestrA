import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listCredentials, writeCredential } from "@dem/engine";
import { runSessionCommand, SESSION_COMMANDS } from "@dem/cli";
import { withTempDir } from "../helpers/temp.js";

/**
 * Managing models from inside the session (SPEC §33.4).
 *
 * `dem setup` covered the first minute and then stopped mattering. Changing a
 * model, adding a second provider, or fixing a mistyped endpoint meant leaving
 * the session, editing JSON, and starting again — so the harness was
 * configurable exactly once, at the moment the user knew least about what they
 * wanted.
 *
 * Everything here runs against a real config file in a temporary workspace.
 * A command that claims to have written something and has not is the failure
 * worth catching.
 */

interface Captured {
  lines: string[];
  io: { out(t: string): void; err(t: string): void };
}

function capture(): Captured {
  const lines: string[] = [];
  const write = (t: string) => { lines.push(t); };
  return { lines, io: { out: write, err: write } };
}

const text = (c: Captured) => c.lines.join("");

async function writeConfig(workspace: string, config: unknown): Promise<void> {
  await mkdir(join(workspace, ".dem"), { recursive: true });
  await writeFile(join(workspace, ".dem", "config.json"), JSON.stringify(config, null, 2));
}

async function readConfig(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(workspace, ".dem", "config.json"), "utf8"));
}

/** Answers prompts in order, so a multi-step command can be driven by a test. */
const scripted = (answers: string[]) => async () => answers.shift() ?? "";

describe("The commands a session offers", () => {
  it("lists them, so the session is discoverable without the README", () => {
    const names = SESSION_COMMANDS.map((c) => c.name);
    expect(names).toContain("/model");
    expect(names).toContain("/provider");
    expect(names).toContain("/help");
    for (const command of SESSION_COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  it("describes each one in a line a person can act on", async () => {
    const c = capture();
    await runSessionCommand("/help", { workspace: ".", io: c.io, ask: scripted([]) });
    for (const command of SESSION_COMMANDS) {
      expect(text(c)).toContain(command.name);
    }
  });

  it("says so for something it does not know, rather than staying silent", async () => {
    const c = capture();
    const result = await runSessionCommand("/frobnicate", {
      workspace: ".", io: c.io, ask: scripted([]),
    });
    expect(result.handled).toBe(true);
    expect(text(c)).toMatch(/unknown|not a command/i);
  });
});

describe("/provider — choosing, adding and removing", () => {
  it("shows what is configured and which one is in use", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        provider: "b",
        providers: {
          a: { baseUrl: "http://10.0.0.1/v1", model: "m1" },
          b: { baseUrl: "http://10.0.0.2/v1", model: "m2" },
        },
      });
      const c = capture();
      await runSessionCommand("/provider", { workspace, io: c.io, ask: scripted([""]) });

      expect(text(c)).toContain("a");
      expect(text(c)).toContain("b");
      // Which one is active has to be visible, or the list is a quiz.
      expect(text(c)).toMatch(/b[\s\S]*(current|active|in use|•)/i);
    });
  });

  it("switches to another and writes it down", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        provider: "a",
        providers: { a: { baseUrl: "http://10.0.0.1/v1" }, b: { baseUrl: "http://10.0.0.2/v1" } },
      });
      const result = await runSessionCommand("/provider b", {
        workspace, io: capture().io, ask: scripted([]),
      });

      expect(result.changed).toBe(true);
      expect((await readConfig(workspace))["provider"]).toBe("b");
    });
  });

  it("refuses a name that is not configured, and says what is", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, { providers: { real: { baseUrl: "http://10.0.0.1/v1" } } });
      const c = capture();
      const result = await runSessionCommand("/provider typo", {
        workspace, io: c.io, ask: scripted([]),
      });

      expect(result.changed).toBe(false);
      expect(text(c)).toContain("real");
    });
  });

  it("adds one, asking for the endpoint and the key", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        const c = capture();
        const result = await runSessionCommand("/provider add", {
          workspace,
          home,
          io: c.io,
          ask: scripted(["openai", "https://api.openai.com/v1", "gpt-5", "y", "sk-test-key-1234"]),
        });

        expect(result.changed).toBe(true);
        const config = await readConfig(workspace);
        const entry = (config["providers"] as Record<string, Record<string, unknown>>)["openai"];
        expect(entry?.["baseUrl"]).toBe("https://api.openai.com/v1");
        expect(entry?.["model"]).toBe("gpt-5");

        // The key goes to the credential store, never into the config file.
        expect(entry?.["apiKey"]).toBe("secret://openai");
        expect(JSON.stringify(config)).not.toContain("sk-test-key-1234");
        expect((await listCredentials(home)).map((x) => x.name)).toContain("openai");
      });
    });
  });

  it("does not ask for a key when told there is none", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await runSessionCommand("/provider add", {
          workspace, home, io: capture().io,
          ask: scripted(["local", "http://127.0.0.1:11434/v1", "qwen", "n"]),
        });
        const config = await readConfig(workspace);
        const entry = (config["providers"] as Record<string, Record<string, unknown>>)["local"];
        expect(entry?.["apiKey"]).toBeUndefined();
        expect(await listCredentials(home)).toHaveLength(0);
      });
    });
  });

  it("removes one", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        providers: { keep: { baseUrl: "http://10.0.0.1/v1" }, drop: { baseUrl: "http://10.0.0.2/v1" } },
      });
      const result = await runSessionCommand("/provider remove drop", {
        workspace, io: capture().io, ask: scripted([]),
      });

      expect(result.changed).toBe(true);
      const providers = (await readConfig(workspace))["providers"] as Record<string, unknown>;
      expect(Object.keys(providers)).toEqual(["keep"]);
    });
  });

  it("does not leave the session pointing at a provider it just removed", async () => {
    // Otherwise the next turn fails with "no provider named ..." and the user
    // has to work out that they did it to themselves.
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        provider: "drop",
        providers: { keep: { baseUrl: "http://10.0.0.1/v1" }, drop: { baseUrl: "http://10.0.0.2/v1" } },
      });
      await runSessionCommand("/provider remove drop", {
        workspace, io: capture().io, ask: scripted([]),
      });
      expect((await readConfig(workspace))["provider"]).not.toBe("drop");
    });
  });
});

describe("/model — what this provider is asked for", () => {
  it("shows what the endpoint reports and marks the current one", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, { baseUrl: "http://127.0.0.1:1/v1", model: "configured" });
      const c = capture();
      await runSessionCommand("/model", {
        workspace, io: c.io, ask: scripted([""]),
        // Injected, so the test does not need a server: the command's job is
        // to render a list and write a choice, not to fetch.
        listModels: async () => ["alpha", "configured", "beta"],
      });

      expect(text(c)).toContain("alpha");
      expect(text(c)).toContain("configured");
    });
  });

  it("sets the model by name", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, { baseUrl: "http://127.0.0.1:1/v1", model: "old" });
      const result = await runSessionCommand("/model beta", {
        workspace, io: capture().io, ask: scripted([]),
        listModels: async () => ["old", "beta"],
      });

      expect(result.changed).toBe(true);
      expect((await readConfig(workspace))["model"]).toBe("beta");
    });
  });

  it("sets the model on the selected provider, not the top level", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        provider: "a",
        providers: { a: { baseUrl: "http://10.0.0.1/v1", model: "old" } },
      });
      await runSessionCommand("/model new", {
        workspace, io: capture().io, ask: scripted([]), listModels: async () => ["old", "new"],
      });

      const config = await readConfig(workspace);
      expect((config["providers"] as Record<string, Record<string, unknown>>)["a"]?.["model"]).toBe("new");
      expect(config["model"]).toBeUndefined();
    });
  });

  it("reports an endpoint it cannot reach instead of showing an empty list", async () => {
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, { baseUrl: "http://127.0.0.1:1/v1" });
      const c = capture();
      await runSessionCommand("/model", {
        workspace, io: c.io, ask: scripted([""]),
        listModels: async () => { throw new Error("connection refused"); },
      });
      expect(text(c)).toMatch(/could not|refused|unreachable/i);
    });
  });
});

describe("Changes survive the session that made them", () => {
  it("keeps settings the command did not touch", async () => {
    // A session command rewriting the file must not drop a security block
    // someone put there deliberately.
    await withTempDir(async (workspace) => {
      await writeConfig(workspace, {
        security: { maxMode: "READ_ONLY", denyCommands: ["rm"] },
        providers: { a: { baseUrl: "http://10.0.0.1/v1" }, b: { baseUrl: "http://10.0.0.2/v1" } },
      });
      await runSessionCommand("/provider b", { workspace, io: capture().io, ask: scripted([]) });

      const config = await readConfig(workspace);
      expect(config["security"]).toEqual({ maxMode: "READ_ONLY", denyCommands: ["rm"] });
    });
  });

  it("reports a credential already stored rather than overwriting it silently", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeCredential("openai", "sk-existing-0000", home);
        const c = capture();
        await runSessionCommand("/provider add", {
          workspace, home, io: c.io,
          ask: scripted(["openai", "https://api.openai.com/v1", "gpt-5", "n"]),
        });
        expect(text(c)).toMatch(/already/i);
        expect(await readCredentialValue(home)).toBe("sk-existing-0000");
      });
    });
  });
});

async function readCredentialValue(home: string): Promise<string | undefined> {
  const { readCredential } = await import("@dem/engine");
  return readCredential("openai", home);
}
