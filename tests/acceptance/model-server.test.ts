import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModelServer, isListening } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * Starting a local model server when one is configured but absent.
 *
 * Without this, the local path — the one this harness is built around — was
 * the most awkward: a second terminal, a remembered port, and a `baseUrl` kept
 * in sync with it by hand.
 *
 * The stand-in takes the same argument shape as `llama serve`, so the launcher
 * is exercised without a model file or a GPU.
 */

const FAKE_SERVER = fileURLToPath(new URL("../helpers/fake-model-server.mjs", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("An already-running server is reused, not replaced", () => {
  it("attaches to what is there rather than starting another", async () => {
    // A user who started a server deliberately, with flags tuned for their
    // hardware, should not have it duplicated or overridden by our guess.
    const port = await freePort();
    const existing = createServer((_, res) => res.end("ok"));
    await new Promise<void>((resolve) => existing.listen(port, "127.0.0.1", resolve));

    try {
      const server = await ensureModelServer(`http://127.0.0.1:${port}`, {});
      expect(server.started).toBe(false);
    } finally {
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });

  it("reports an empty port as empty", async () => {
    const port = await freePort();
    expect(await isListening(`http://127.0.0.1:${port}`)).toBe(false);
  });
});

describe("Starting one, when a model is configured", () => {
  it("launches the server and waits until it is actually listening", async () => {
    // Returning before the port is open would hand the caller a URL that
    // refuses connections for the next few seconds.
    await withTempDir(async (dir) => {
      const modelPath = join(dir, "model.gguf");
      await writeFile(modelPath, "not really a model");
      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${port}`;

      const server = await ensureModelServer(baseUrl, {
        command: process.execPath,
        commandArgs: [FAKE_SERVER],
        modelPath,
        startupTimeoutMs: 20_000,
      });

      try {
        expect(server.started).toBe(true);
        expect(await isListening(baseUrl)).toBe(true);
      } finally {
        await server.stop();
      }
    });
  }, 30_000);
});

describe("Failures explain themselves", () => {
  it("says what to do when nothing is running and nothing is configured", async () => {
    const port = await freePort();
    await expect(ensureModelServer(`http://127.0.0.1:${port}`, {})).rejects.toThrow(/modelPath/);
  });

  it("refuses a modelPath that does not exist, before spawning anything", async () => {
    const port = await freePort();
    await expect(
      ensureModelServer(`http://127.0.0.1:${port}`, { modelPath: "/no/such/model.gguf" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("reports a missing binary rather than waiting for a port that never opens", async () => {
    await withTempDir(async (dir) => {
      const modelPath = join(dir, "model.gguf");
      await writeFile(modelPath, "x");
      const port = await freePort();

      await expect(
        ensureModelServer(`http://127.0.0.1:${port}`, {
          command: "definitely-not-a-real-binary-xyz",
          modelPath,
          startupTimeoutMs: 5_000,
        }),
      ).rejects.toThrow(/could not start/);
    });
  });

  it("surfaces the server's own startup output when it exits", async () => {
    // "Timed out waiting for a port" hides the reason; the server printed one.
    await withTempDir(async (dir) => {
      const modelPath = join(dir, "SCENARIO_EXIT.gguf");
      await writeFile(modelPath, "x");
      const port = await freePort();

      await expect(
        ensureModelServer(`http://127.0.0.1:${port}`, {
          command: process.execPath,
          commandArgs: [FAKE_SERVER],
          modelPath,
          startupTimeoutMs: 10_000,
        }),
      ).rejects.toThrow(/unsupported file type/);
    });
  });

  it("requires a port in the baseUrl, since it has to tell the server one", async () => {
    await expect(ensureModelServer("http://127.0.0.1", { modelPath: FAKE_SERVER })).rejects.toThrow(
      /port/,
    );
  });
});
