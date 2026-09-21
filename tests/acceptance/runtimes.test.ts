import { describe, expect, it } from "vitest";
import {
  DEFAULT_START_OPTIONS,
  RUNTIMES,
  runtimeById,
  startArgs,
  effectiveProvider,
  resolveSettings,
} from "@dem/engine";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "../helpers/temp.js";

/**
 * Runtimes (SPEC §33.5).
 *
 * "보통 프로바이더 선택시 llama.cpp인지 ollama 인지 lm studio 인지 ... 이건 아직
 * 없네. 모델 시동 옵션도 넣을 수 있어야 하는데."
 *
 * Both true. Every local server was "an OpenAI-compatible baseUrl", so there
 * was no way to say which, and no place for the options only one of them has.
 */

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await mkdir(join(dir, ".dem"), { recursive: true });
  await writeFile(join(dir, ".dem", "config.json"), JSON.stringify(config, null, 2));
}

describe("The runtimes on offer", () => {
  it("covers the local servers and the remote ones", () => {
    const ids = RUNTIMES.map((r) => r.id);
    expect(ids).toContain("llama.cpp");
    expect(ids).toContain("ollama");
    expect(ids).toContain("lm-studio");
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("claude-cli");
  });

  it("says which one dem starts itself", () => {
    expect(runtimeById("llama.cpp")?.serves).toBe(true);
    expect(runtimeById("ollama")?.serves).toBe(false);
  });

  it("asks only for what a runtime needs", () => {
    // Asking Ollama for a gguf path, or the Anthropic API for a port, is how a
    // configuration screen teaches people to ignore it.
    expect(runtimeById("llama.cpp")?.fields).toContain("modelPath");
    expect(runtimeById("llama.cpp")?.fields).toContain("startOptions");
    expect(runtimeById("ollama")?.fields).not.toContain("modelPath");
    expect(runtimeById("anthropic")?.fields).not.toContain("baseUrl");
    expect(runtimeById("claude-cli")?.fields).toEqual(["model"]);
  });

  it("marks the Claude CLI as remote although its binary is local", () => {
    // The gate follows the data, not the executable (invariant 1).
    expect(runtimeById("claude-cli")?.local).toBe(false);
    expect(runtimeById("ollama")?.local).toBe(true);
  });

  it("says outright that the Claude CLI cannot call tools", () => {
    // Known in advance, so it is not discovered by probing or, worse, by a
    // session that answers every message with a refusal (invariant 41).
    expect(runtimeById("claude-cli")?.toolCalling).toBe(false);
    expect(runtimeById("llama.cpp")?.toolCalling).toBeUndefined();
  });

  it("gives each one a line that distinguishes it", () => {
    for (const runtime of RUNTIMES) {
      expect(runtime.summary.length).toBeGreaterThan(10);
    }
    expect(new Set(RUNTIMES.map((r) => r.summary)).size).toBe(RUNTIMES.length);
  });
});

describe("Start options reach the server", () => {
  it("turns options into arguments", () => {
    expect(startArgs({ contextSize: 8192, gpuLayers: -1, kvCache: "q8_0", flashAttention: true }))
      .toEqual(["-c", "8192", "-ngl", "-1", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"]);
  });

  it("does not pass a cache type for fp16, which is the server's own default", () => {
    expect(startArgs({ kvCache: "fp16" })).toEqual([]);
  });

  it("passes anything else through", () => {
    expect(startArgs({ extraArgs: ["--threads", "8"] })).toEqual(["--threads", "8"]);
  });

  it("defaults to what was measured, not to the server's defaults", () => {
    // q8_0 scored identically to fp16 and eleven times faster; -ngl -1 rather
    // than 999 because forcing every layer onto an 8GB card served one request
    // and then died.
    expect(DEFAULT_START_OPTIONS.kvCache).toBe("q8_0");
    expect(DEFAULT_START_OPTIONS.gpuLayers).toBe(-1);
    expect(DEFAULT_START_OPTIONS.flashAttention).toBe(true);
  });
});

describe("A provider entry carries its runtime", () => {
  it("resolves the runtime and its options", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: {
            local: {
              runtime: "llama.cpp",
              modelPath: "E:/models/x.gguf",
              options: { contextSize: 4096, kvCache: "q8_0" },
            },
          },
        });
        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        const chosen = await effectiveProvider(settings, "local", home);

        expect(chosen.runtime).toBe("llama.cpp");
        expect(chosen.modelPath).toBe("E:/models/x.gguf");
        expect(chosen.options?.contextSize).toBe(4096);
      });
    });
  });

  it("supplies the runtime's default endpoint when none is written", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          providers: { o: { runtime: "ollama", model: "qwen" } },
        });
        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        const chosen = await effectiveProvider(settings, "o", home);
        expect(chosen.baseUrl).toBe("http://127.0.0.1:11434/v1");
      });
    });
  });

  it("still reads a configuration written before runtimes existed", async () => {
    // Someone's working setup must not stop working because the shape grew.
    await withTempDir(async (home) => {
      await withTempDir(async (workspace) => {
        await writeConfig(workspace, {
          baseUrl: "http://127.0.0.1:8099",
          model: "qwen",
          modelPath: "E:/models/x.gguf",
        });
        const settings = await resolveSettings({ workspace, home, env: {}, cli: {} });
        const chosen = await effectiveProvider(settings, undefined, home);

        expect(chosen.baseUrl).toBe("http://127.0.0.1:8099");
        expect(chosen.modelPath).toBe("E:/models/x.gguf");
      });
    });
  });
});
