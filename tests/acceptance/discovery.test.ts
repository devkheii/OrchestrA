import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverServers, discoverWeights, labelForModels } from "@dem/engine";
import { withTempDir } from "../helpers/temp.js";

/**
 * Finding what is already on the machine.
 *
 * Without this, a first run needs the user to know that they want an
 * OpenAI-compatible endpoint, which port theirs is on, what their model is
 * called, and where `.dem/config.json` goes. Everyone who already knows that
 * has a harness. The gap is not a missing feature, it is the absence of a
 * first minute.
 *
 * Nothing here guesses. It reports what answered.
 */

async function fakeEndpoint(models: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

describe("Finding a server that is already running", () => {
  it("reports an endpoint that answers, with the models it serves", async () => {
    const endpoint = await fakeEndpoint(["qwen2.5-coder", "llama3.1"]);
    try {
      const found = await discoverServers({ ports: [endpoint.port], timeoutMs: 2000 });
      expect(found).toHaveLength(1);
      expect(found[0]!.baseUrl).toBe(`http://127.0.0.1:${endpoint.port}`);
      expect(found[0]!.models).toEqual(["qwen2.5-coder", "llama3.1"]);
    } finally {
      await endpoint.close();
    }
  });

  it("says nothing about ports where nothing answers", async () => {
    // Silence is the common case on a fresh machine and must not look like a
    // failure, or the first run opens with an error the user did not cause.
    const found = await discoverServers({ ports: [59_999], timeoutMs: 500 });
    expect(found).toEqual([]);
  });

  it("does not hang on a port that accepts and never replies", async () => {
    // A port held open by something that is not an API would otherwise stall
    // the first run for as long as the caller is patient.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const started = Date.now();
      const found = await discoverServers({ ports: [port], timeoutMs: 800 });
      expect(found).toEqual([]);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      silent.closeAllConnections?.();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("scans several ports without waiting for each one in turn", async () => {
    const a = await fakeEndpoint(["a"]);
    const b = await fakeEndpoint(["b"]);
    try {
      const dead = [59_990, 59_991, 59_992, 59_993];
      const started = Date.now();
      const found = await discoverServers({ ports: [...dead, a.port, b.port], timeoutMs: 1500 });
      expect(found.map((f) => f.models[0]).sort()).toEqual(["a", "b"]);
      // Sequential probing of six ports would take at least four timeouts.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("names what is probably running, from the port it answered on", async () => {
    // "http://127.0.0.1:11434" means nothing to most people; "Ollama" does.
    const endpoint = await fakeEndpoint(["x"]);
    try {
      const found = await discoverServers({ ports: [endpoint.port], timeoutMs: 2000 });
      expect(found[0]!.kind).toBeTruthy();
    } finally {
      await endpoint.close();
    }
  });
});

describe("Finding weights on disk", () => {
  it("reports .gguf files with their sizes", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "model-a.gguf"), "x".repeat(2048));
      await writeFile(join(dir, "notes.txt"), "not a model");

      const found = await discoverWeights({ dirs: [dir] });
      expect(found).toHaveLength(1);
      expect(found[0]!.path).toContain("model-a.gguf");
      expect(found[0]!.sizeBytes).toBe(2048);
    });
  });

  it("looks one level down, because model directories are usually nested", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "qwen"), { recursive: true });
      await writeFile(join(dir, "qwen", "model.gguf"), "y");
      const found = await discoverWeights({ dirs: [dir] });
      expect(found).toHaveLength(1);
    });
  });

  it("ignores a directory that is not there, rather than failing", async () => {
    const found = await discoverWeights({ dirs: [join("/no", "such", "place")] });
    expect(found).toEqual([]);
  });

  it("puts the largest first, since that is usually the most capable", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "small.gguf"), "x".repeat(100));
      await writeFile(join(dir, "big.gguf"), "x".repeat(5000));
      const found = await discoverWeights({ dirs: [dir] });
      expect(found[0]!.path).toContain("big.gguf");
    });
  });
});

describe("Naming things a person can recognise", () => {
  it("shortens a model list rather than printing forty ids", () => {
    const many = Array.from({ length: 40 }, (_, i) => `model-${i}`);
    const label = labelForModels(many);
    expect(label.length).toBeLessThan(120);
    expect(label).toContain("40");
  });

  it("prints a short list in full", () => {
    expect(labelForModels(["qwen", "llama"])).toBe("qwen, llama");
  });

  it("says so when a server reports nothing", () => {
    expect(labelForModels([])).toMatch(/no models|unknown/i);
  });
});
