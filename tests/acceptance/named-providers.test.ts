import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveProvider, resolveSettings, writeCredential } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * Naming a provider, so an endpoint has somewhere to live (SPEC §33.2).
 *
 * `dem auth add` stores a key and nothing else, which is correct — it is the
 * secret store — and on its own it is half a configuration. A credential with
 * no endpoint cannot be used, and the settings it would have joined held one
 * `baseUrl` and one `model`, so a second endpoint had nowhere to go at all.
 *
 * That is not an edge case for this project. A council is several models from
 * several places by definition, so "more than one provider" is the ordinary
 * shape and the configuration has to express it.
 */

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await mkdir(join(dir, ".dem"), { recursive: true });
  await writeFile(join(dir, ".dem", "config.json"), JSON.stringify(config, null, 2));
}

const load = (workspace: string, home: string, cli: Record<string, unknown> = {}) =>
  resolveSettings({ workspace, home, env: {}, cli });

describe("Several providers, each with its own endpoint and key", () => {
  it("keeps them apart instead of collapsing them into one setting", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: {
            "qwen-27b": {
              baseUrl: "http://10.0.0.1:8002/v1",
              model: "qwen3.8-27b",
              apiKey: "secret://qwen-27b",
            },
            "qwen-flash": {
              baseUrl: "http://10.0.0.2:8000/v1",
              model: "qwen3.8-flash-next",
              apiKey: "secret://qwen-flash",
            },
          },
        });
        await writeCredential("qwen-27b", "sk-key-for-27b-1111", home);
        await writeCredential("qwen-flash", "sk-key-for-flash-2222", home);

        const settings = await load(workspace, home);

        const big = await effectiveProvider(settings, "qwen-27b", home);
        expect(big.baseUrl).toBe("http://10.0.0.1:8002/v1");
        expect(big.model).toBe("qwen3.8-27b");
        expect(big.apiKey).toBe("sk-key-for-27b-1111");

        const small = await effectiveProvider(settings, "qwen-flash", home);
        expect(small.baseUrl).toBe("http://10.0.0.2:8000/v1");
        expect(small.apiKey).toBe("sk-key-for-flash-2222");
      });
    });
  });

  it("resolves each name to its own credential, not to a shared one", async () => {
    // The failure this prevents: one key reaching an endpoint that did not
    // issue it, because both providers read the same setting.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: {
            a: { baseUrl: "http://10.0.0.1/v1", apiKey: "secret://key-a" },
            b: { baseUrl: "http://10.0.0.2/v1", apiKey: "secret://key-b" },
          },
        });
        await writeCredential("key-a", "sk-aaaa-1111", home);
        await writeCredential("key-b", "sk-bbbb-2222", home);

        const settings = await load(workspace, home);
        expect((await effectiveProvider(settings, "a", home)).apiKey).toBe("sk-aaaa-1111");
        expect((await effectiveProvider(settings, "b", home)).apiKey).toBe("sk-bbbb-2222");
      });
    });
  });
});

describe("Choosing which one runs", () => {
  it("uses the one named in config when nothing is asked for", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          provider: "qwen-flash",
          providers: {
            "qwen-27b": { baseUrl: "http://10.0.0.1/v1" },
            "qwen-flash": { baseUrl: "http://10.0.0.2/v1" },
          },
        });
        const settings = await load(workspace, home);
        expect((await effectiveProvider(settings, undefined, home)).baseUrl).toBe(
          "http://10.0.0.2/v1",
        );
      });
    });
  });

  it("uses the only one there is, when there is only one", async () => {
    // Making someone name the single thing they configured is ceremony.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { solo: { baseUrl: "http://10.0.0.9/v1", model: "m" } },
        });
        const settings = await load(workspace, home);
        expect((await effectiveProvider(settings, undefined, home)).model).toBe("m");
      });
    });
  });

  it("refuses to guess when several exist and none is chosen", async () => {
    // Picking one silently would send the workspace to an endpoint the user
    // did not select, which is the kind of thing discovered months later.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { a: { baseUrl: "http://10.0.0.1/v1" }, b: { baseUrl: "http://10.0.0.2/v1" } },
        });
        const settings = await load(workspace, home);
        await expect(effectiveProvider(settings, undefined, home)).rejects.toThrow(/a, b|which/i);
      });
    });
  });

  it("says what exists when asked for a name that does not", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, { providers: { real: { baseUrl: "http://10.0.0.1/v1" } } });
        const settings = await load(workspace, home);
        await expect(effectiveProvider(settings, "typo", home)).rejects.toThrow(/real/);
      });
    });
  });

  it("still understands a built-in kind rather than a configured name", async () => {
    // `--provider anthropic` has to keep working for someone who configured
    // nothing at all.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        const settings = await load(workspace, home, { provider: "anthropic" });
        const chosen = await effectiveProvider(settings, "anthropic", home);
        expect(chosen.kind).toBe("anthropic");
      });
    });
  });
});

describe("A literal key is refused wherever it is written", () => {
  it("refuses one inside a named provider, not only at the top level", async () => {
    // The check knew about `apiKey` at the root. Nesting is exactly where a
    // second look stops happening.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-liveKey123456" } },
        });
        await expect(load(workspace, home)).rejects.toThrow(/credential|secret:\/\//i);
      });
    });
  });

  it("accepts a reference in a named provider", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "env://OPENAI_KEY" } },
        });
        await expect(load(workspace, home)).resolves.toBeDefined();
      });
    });
  });
});

describe("A missing credential is reported, not worked around", () => {
  it("names the provider and the command that would fix it", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "secret://openai" } },
        });
        const settings = await load(workspace, home);
        await expect(effectiveProvider(settings, "openai", home)).rejects.toThrow(
          /dem auth add openai/,
        );
      });
    });
  });
});

describe("Which endpoint the weights belong to", () => {
  /**
   * From a real session: the selected provider was a remote endpoint, and
   * `dem` loaded a 5.8GB local model first, waited for it, and then checked
   * the remote one.
   *
   * `modelPath` sat at the top level next to a `baseUrl` of 127.0.0.1:8099
   * from an earlier `dem setup`, and a named provider had been added since.
   * Serving weights is paired with an endpoint; it is not a global setting
   * that applies to whichever provider happens to be selected.
   */
  it("carries modelPath on the provider it belongs to", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: {
            local: {
              baseUrl: "http://127.0.0.1:8099",
              model: "qwen",
              modelPath: "E:/models/qwen.gguf",
            },
          },
        });
        const settings = await load(workspace, home);
        const chosen = await effectiveProvider(settings, "local", home);
        expect(chosen.modelPath).toBe("E:/models/qwen.gguf");
      });
    });
  });

  it("does not hand a named remote provider the top-level modelPath", async () => {
    // The bug exactly: weights configured for a local endpoint must not be
    // loaded because a different, remote provider was selected.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          modelPath: "E:/models/qwen.gguf",
          baseUrl: "http://127.0.0.1:8099",
          provider: "remote",
          providers: { remote: { baseUrl: "http://10.0.0.1:8000/v1", model: "m" } },
        });
        const settings = await load(workspace, home);
        const chosen = await effectiveProvider(settings, undefined, home);

        expect(chosen.baseUrl).toBe("http://10.0.0.1:8000/v1");
        expect(chosen.modelPath).toBeUndefined();
      });
    });
  });

  it("still serves the flat configuration a setup run writes", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          modelPath: "E:/models/qwen.gguf",
          baseUrl: "http://127.0.0.1:8099",
          model: "qwen",
        });
        const settings = await load(workspace, home);
        const chosen = await effectiveProvider(settings, undefined, home);
        expect(chosen.modelPath).toBe("E:/models/qwen.gguf");
      });
    });
  });
});
